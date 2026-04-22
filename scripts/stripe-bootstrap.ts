/**
 * Stripe bootstrap — idempotent setup of products, prices, and webhook.
 *
 * Run via `.github/workflows/stripe-bootstrap.yml` (manual dispatch). Reads
 * STRIPE_SECRET_KEY + APP_BASE_URL from env. Creates the 4 plan tiers
 * (free is a no-op; pro/team/enterprise each get a product + monthly price
 * with a lookup_key matching `gluecron_${slug}_monthly`). Then creates/
 * updates the webhook endpoint at `${APP_BASE_URL}/api/webhooks/stripe`.
 *
 * Idempotent: re-running is safe. Prices are matched by lookup_key, products
 * by name, webhooks by URL.
 *
 * Outputs (printed to stdout, masked in GH Actions):
 *   - The webhook signing secret (whsec_...) — must be stored as a
 *     Fly secret STRIPE_WEBHOOK_SECRET.
 *
 * This script uses only fetch + URLSearchParams — no Stripe SDK dependency.
 */

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const APP_BASE_URL = process.env.APP_BASE_URL || "https://gluecron.fly.dev";

if (!STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY not set — aborting.");
  process.exit(1);
}

const PLANS = [
  { slug: "pro", name: "Gluecron Pro", priceCents: 900 },
  { slug: "team", name: "Gluecron Team", priceCents: 2900 },
  { slug: "enterprise", name: "Gluecron Enterprise", priceCents: 9900 },
] as const;

const WEBHOOK_URL = `${APP_BASE_URL.replace(/\/$/, "")}/api/webhooks/stripe`;
const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
];

type StripeResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function stripe<T = any>(
  path: string,
  body?: Record<string, string | string[]>,
  method: "GET" | "POST" | "DELETE" = body ? "POST" : "GET"
): Promise<StripeResult<T>> {
  const url = `https://api.stripe.com/v1${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (Array.isArray(v)) {
        for (const item of v) params.append(`${k}[]`, item);
      } else {
        params.append(k, v);
      }
    }
    init.body = params.toString();
  }
  try {
    const res = await fetch(url, init);
    const json = await res.json();
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${json.error?.message || JSON.stringify(json)}` };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function findProductByName(name: string): Promise<string | null> {
  const res = await stripe<{ data: Array<{ id: string; name: string; active: boolean }> }>(
    `/products?limit=100&active=true`
  );
  if (!res.ok) return null;
  const match = res.data.data.find((p) => p.name === name);
  return match?.id ?? null;
}

async function findPriceByLookupKey(lookupKey: string): Promise<string | null> {
  const res = await stripe<{ data: Array<{ id: string; lookup_key: string }> }>(
    `/prices?limit=100&lookup_keys[]=${encodeURIComponent(lookupKey)}`
  );
  if (!res.ok) return null;
  return res.data.data[0]?.id ?? null;
}

async function findWebhookByUrl(url: string): Promise<string | null> {
  const res = await stripe<{ data: Array<{ id: string; url: string }> }>(
    `/webhook_endpoints?limit=100`
  );
  if (!res.ok) return null;
  return res.data.data.find((w) => w.url === url)?.id ?? null;
}

async function ensureProduct(plan: (typeof PLANS)[number]): Promise<string> {
  const existing = await findProductByName(plan.name);
  if (existing) {
    console.log(`  ✓ Product already exists: ${plan.name} (${existing})`);
    return existing;
  }
  const res = await stripe<{ id: string }>(`/products`, {
    name: plan.name,
    "metadata[gluecron_plan_slug]": plan.slug,
  });
  if (!res.ok) throw new Error(`Failed to create product ${plan.name}: ${res.error}`);
  console.log(`  + Created product: ${plan.name} (${res.data.id})`);
  return res.data.id;
}

async function ensurePrice(
  productId: string,
  plan: (typeof PLANS)[number]
): Promise<string> {
  const lookupKey = `gluecron_${plan.slug}_monthly`;
  const existing = await findPriceByLookupKey(lookupKey);
  if (existing) {
    console.log(`  ✓ Price already exists: ${lookupKey} (${existing})`);
    return existing;
  }
  const res = await stripe<{ id: string }>(`/prices`, {
    product: productId,
    unit_amount: String(plan.priceCents),
    currency: "usd",
    "recurring[interval]": "month",
    lookup_key: lookupKey,
    "metadata[gluecron_plan_slug]": plan.slug,
  });
  if (!res.ok) throw new Error(`Failed to create price ${lookupKey}: ${res.error}`);
  console.log(`  + Created price: ${lookupKey} (${res.data.id})`);
  return res.data.id;
}

async function ensureWebhook(): Promise<{ id: string; secret: string | null }> {
  const existing = await findWebhookByUrl(WEBHOOK_URL);
  if (existing) {
    console.log(`  ✓ Webhook already exists for ${WEBHOOK_URL} (${existing})`);
    console.log(`    (signing secret is only shown at creation; not re-retrievable)`);
    return { id: existing, secret: null };
  }
  const res = await stripe<{ id: string; secret: string }>(`/webhook_endpoints`, {
    url: WEBHOOK_URL,
    enabled_events: WEBHOOK_EVENTS,
    description: "gluecron billing webhook (auto-created by stripe-bootstrap.ts)",
  });
  if (!res.ok) throw new Error(`Failed to create webhook: ${res.error}`);
  console.log(`  + Created webhook: ${WEBHOOK_URL} (${res.data.id})`);
  return { id: res.data.id, secret: res.data.secret };
}

async function main() {
  const mode = STRIPE_SECRET_KEY.startsWith("sk_live_") ? "LIVE" : "TEST";
  console.log(`\nStripe bootstrap — ${mode} mode`);
  console.log(`App base URL: ${APP_BASE_URL}`);
  console.log(`Webhook URL:  ${WEBHOOK_URL}\n`);

  console.log("== Products + prices ==");
  for (const plan of PLANS) {
    const productId = await ensureProduct(plan);
    await ensurePrice(productId, plan);
  }

  console.log("\n== Webhook endpoint ==");
  const webhook = await ensureWebhook();

  console.log("\n== Summary ==");
  console.log(`Mode: ${mode}`);
  console.log(`Products: ${PLANS.length} (pro/team/enterprise)`);
  console.log(`Webhook: ${webhook.id}`);

  if (webhook.secret) {
    console.log("\n⚠️  WEBHOOK SIGNING SECRET (save this — only shown once):");
    console.log(`STRIPE_WEBHOOK_SECRET=${webhook.secret}`);
    // GitHub Actions masking so it doesn't land in logs
    console.log(`::add-mask::${webhook.secret}`);
    // Emit for workflow step to capture
    if (process.env.GITHUB_OUTPUT) {
      const fs = await import("fs");
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `webhook_secret=${webhook.secret}\n`
      );
    }
  } else {
    console.log("\n(Webhook already existed — signing secret not re-retrievable.)");
    console.log("If you need to rotate it, delete the webhook in the Stripe dashboard");
    console.log("and re-run this script.");
  }
}

main().catch((err) => {
  console.error("Bootstrap failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
