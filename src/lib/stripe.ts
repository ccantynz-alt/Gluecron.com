/**
 * Stripe REST helpers — fetch-based, no SDK dependency. Used by the billing
 * upgrade flow and the webhook handler.
 *
 * All fns return discriminated `{ ok: true, ... }` / `{ ok: false, error }`
 * results. Never throws — a Stripe outage must not break the primary
 * request path.
 *
 * `STRIPE_SECRET_KEY` is read at call time (not module init) so tests can
 * mutate env without reloading the module.
 */

const STRIPE_API = "https://api.stripe.com/v1";

export type StripeFail = { ok: false; error: string };

function getKey(): string | null {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k || k.length < 10) return null;
  return k;
}

function encodeForm(body: Record<string, string | string[]>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) for (const item of v) params.append(`${k}[]`, item);
    else params.append(k, v);
  }
  return params.toString();
}

async function stripeRequest<T>(
  path: string,
  body?: Record<string, string | string[]>,
  method: "GET" | "POST" | "DELETE" = body ? "POST" : "GET"
): Promise<{ ok: true; data: T } | StripeFail> {
  const key = getKey();
  if (!key) return { ok: false, error: "STRIPE_SECRET_KEY not configured" };
  try {
    const res = await fetch(`${STRIPE_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body ? encodeForm(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) {
      return {
        ok: false,
        error: `stripe ${method} ${path} ${res.status}: ${json.error?.message ?? "unknown"}`,
      };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    return {
      ok: false,
      error: `stripe ${method} ${path} network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

export async function findOrCreateCustomer(args: {
  userId: string;
  email: string;
  existingCustomerId?: string | null;
}): Promise<{ ok: true; customerId: string } | StripeFail> {
  if (args.existingCustomerId) {
    // Trust the caller's stored id; Stripe will 404 if it's stale, we fall
    // back to create.
    const check = await stripeRequest<{ id: string; deleted?: boolean }>(
      `/customers/${encodeURIComponent(args.existingCustomerId)}`
    );
    if (check.ok && !check.data.deleted) {
      return { ok: true, customerId: check.data.id };
    }
  }
  const res = await stripeRequest<{ id: string }>(`/customers`, {
    email: args.email,
    "metadata[gluecron_user_id]": args.userId,
  });
  if (!res.ok) return res;
  return { ok: true, customerId: res.data.id };
}

// ---------------------------------------------------------------------------
// Checkout Session
// ---------------------------------------------------------------------------

export async function createCheckoutSession(args: {
  customerId: string;
  planSlug: "pro" | "team" | "enterprise";
  successUrl: string;
  cancelUrl: string;
  userId: string;
}): Promise<{ ok: true; url: string; sessionId: string } | StripeFail> {
  const lookupKey = `gluecron_${args.planSlug}_monthly`;
  // Resolve price by lookup_key — matches what stripe-bootstrap seeds.
  const priceRes = await stripeRequest<{ data: Array<{ id: string }> }>(
    `/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&limit=1`
  );
  if (!priceRes.ok) return priceRes;
  const priceId = priceRes.data.data[0]?.id;
  if (!priceId) {
    return {
      ok: false,
      error: `no Stripe price found for lookup_key=${lookupKey} — run the Stripe Bootstrap workflow first`,
    };
  }
  const res = await stripeRequest<{ id: string; url: string }>(
    `/checkout/sessions`,
    {
      mode: "subscription",
      customer: args.customerId,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      client_reference_id: args.userId,
      "metadata[gluecron_user_id]": args.userId,
      "metadata[gluecron_plan_slug]": args.planSlug,
      "subscription_data[metadata][gluecron_user_id]": args.userId,
      "subscription_data[metadata][gluecron_plan_slug]": args.planSlug,
    }
  );
  if (!res.ok) return res;
  return { ok: true, url: res.data.url, sessionId: res.data.id };
}

// ---------------------------------------------------------------------------
// Customer Portal (for existing subscribers to manage their plan)
// ---------------------------------------------------------------------------

export async function createBillingPortalSession(args: {
  customerId: string;
  returnUrl: string;
}): Promise<{ ok: true; url: string } | StripeFail> {
  const res = await stripeRequest<{ url: string }>(`/billing_portal/sessions`, {
    customer: args.customerId,
    return_url: args.returnUrl,
  });
  if (!res.ok) return res;
  return { ok: true, url: res.data.url };
}

// ---------------------------------------------------------------------------
// Subscription fetch (used by webhook to enrich on events)
// ---------------------------------------------------------------------------

export type StripeSubscription = {
  id: string;
  status: string;
  customer: string;
  current_period_end: number;
  items: { data: Array<{ price: { id: string; lookup_key?: string } }> };
  metadata?: Record<string, string>;
};

export async function getSubscription(
  subscriptionId: string
): Promise<{ ok: true; subscription: StripeSubscription } | StripeFail> {
  const res = await stripeRequest<StripeSubscription>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`
  );
  if (!res.ok) return res;
  return { ok: true, subscription: res.data };
}

/** Given a Stripe subscription, derive the gluecron plan slug. Prefers
 *  the lookup_key on the price item; falls back to subscription metadata. */
export function planSlugFromSubscription(
  sub: StripeSubscription
): "pro" | "team" | "enterprise" | null {
  const lk = sub.items?.data?.[0]?.price?.lookup_key;
  if (lk?.startsWith("gluecron_") && lk.endsWith("_monthly")) {
    const slug = lk.slice("gluecron_".length, -"_monthly".length);
    if (slug === "pro" || slug === "team" || slug === "enterprise") return slug;
  }
  const metaSlug = sub.metadata?.gluecron_plan_slug;
  if (metaSlug === "pro" || metaSlug === "team" || metaSlug === "enterprise") {
    return metaSlug;
  }
  return null;
}
