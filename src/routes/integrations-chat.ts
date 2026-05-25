/**
 * Chat-bot endpoints — Slack events, Discord interactions, install
 * callbacks. Mounted on `/api/v2/integrations/{slack,discord}/*`.
 *
 * Surface:
 *   POST /slack/events        — Slack Events API + slash commands
 *   POST /discord/interactions — Discord interactions (slash commands)
 *   POST /slack/install        — OAuth completion (placeholder)
 *   POST /discord/install      — OAuth completion (placeholder)
 *
 * Verification:
 *   - Slack: X-Slack-Signature HMAC-SHA256 over `v0:<ts>:<body>`. The
 *     signing secret comes from the chat_integrations row that matches the
 *     incoming team_id.
 *   - Discord: X-Signature-Ed25519 + X-Signature-Timestamp. The Application
 *     Public Key is stored in chat_integrations.signing_secret. We look it
 *     up by guild_id when present, otherwise we accept any row of
 *     kind='discord' that verifies (multi-tenancy is exact-match on the
 *     public key, so this is safe).
 *
 * Dispatch:
 *   - Both endpoints decode the slash-command, call handleBotCommand(), and
 *     return the formatted blocks/embeds inline. We never await long ops
 *     here — anything that would block returns a deep-link instead (see
 *     cmdSpecShip / cmdChat in chat-bot.ts).
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { chatIntegrations } from "../db/schema";
import {
  parseSlackSlashCommand,
  parseDiscordSlashCommand,
  verifySlackSignature,
  verifyDiscordSignature,
  handleBotCommand,
  type DiscordInteractionLike,
} from "../lib/chat-bot";

const r = new Hono();

// ---------------------------------------------------------------------------
// Slack — Events API + slash commands hit the same endpoint.
// ---------------------------------------------------------------------------

r.post("/api/v2/integrations/slack/events", async (c) => {
  const body = await c.req.text();
  const sig = c.req.header("X-Slack-Signature") ?? "";
  const ts = c.req.header("X-Slack-Request-Timestamp") ?? "";

  // url_verification challenge arrives as JSON BEFORE the integration is
  // saved, so we can't reach into chat_integrations for a secret. We MAY
  // accept it without verification because the response (`challenge`) is
  // exactly what Slack sent us — it carries no privileged data. Slack's
  // own docs recommend skipping signature on url_verification.
  if (looksLikeJson(body)) {
    try {
      const parsed = JSON.parse(body) as {
        type?: string;
        challenge?: string;
      };
      if (parsed.type === "url_verification" && parsed.challenge) {
        return c.json({ challenge: parsed.challenge });
      }
    } catch {
      /* fall through */
    }
  }

  // Slash commands and event subscriptions are form-encoded; pull team_id
  // out to find the right signing secret.
  const params = new URLSearchParams(body);
  const teamId = params.get("team_id") ?? "";

  // Find every Slack integration that could possibly own this request — we
  // need the signing_secret to verify. We try each in turn (typical user
  // has one Slack workspace).
  const candidates = await db
    .select()
    .from(chatIntegrations)
    .where(
      and(
        eq(chatIntegrations.kind, "slack"),
        teamId
          ? eq(chatIntegrations.teamId, teamId)
          : eq(chatIntegrations.kind, "slack")
      )
    );

  let matched = null;
  for (const integ of candidates) {
    if (!integ.signingSecret) continue;
    const ok = await verifySlackSignature({
      signingSecret: integ.signingSecret,
      timestamp: ts,
      signature: sig,
      body,
    });
    if (ok) {
      matched = integ;
      break;
    }
  }
  if (!matched) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  // Slash command path: dispatch + return blocks inline.
  const text = params.get("text") ?? "";
  const parsed = parseSlackSlashCommand(text);
  const response = await handleBotCommand({
    kind: "slack",
    userId: matched.ownerUserId,
    command: parsed.command,
    subcommand: parsed.subcommand,
    args: parsed.args,
  });
  return c.json(response);
});

// ---------------------------------------------------------------------------
// Discord — interactions endpoint (Ed25519-signed)
// ---------------------------------------------------------------------------

r.post("/api/v2/integrations/discord/interactions", async (c) => {
  const body = await c.req.text();
  const sig = c.req.header("X-Signature-Ed25519") ?? "";
  const ts = c.req.header("X-Signature-Timestamp") ?? "";

  if (!sig || !ts) {
    return c.json({ error: "missing_signature" }, 401);
  }

  // Look up by guild_id if present in body; else scan all discord rows
  // (typical install volume is small per user — the constant-time verify
  // ensures attackers can't enumerate).
  let guildId: string | null = null;
  try {
    const parsed = JSON.parse(body) as { guild_id?: string };
    guildId = parsed.guild_id ?? null;
  } catch {
    /* not JSON → fail below */
  }

  const candidates = guildId
    ? await db
        .select()
        .from(chatIntegrations)
        .where(
          and(
            eq(chatIntegrations.kind, "discord"),
            eq(chatIntegrations.teamId, guildId)
          )
        )
    : await db
        .select()
        .from(chatIntegrations)
        .where(eq(chatIntegrations.kind, "discord"));

  let matched = null;
  for (const integ of candidates) {
    if (!integ.signingSecret) continue;
    const ok = await verifyDiscordSignature({
      publicKeyHex: integ.signingSecret,
      signatureHex: sig,
      timestamp: ts,
      body,
    });
    if (ok) {
      matched = integ;
      break;
    }
  }
  if (!matched) return c.json({ error: "invalid_signature" }, 401);

  let interaction: DiscordInteractionLike;
  try {
    interaction = JSON.parse(body) as DiscordInteractionLike;
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }

  // PING (type 1) → PONG (type 1). Discord uses this every few minutes.
  if (interaction.type === 1) {
    return c.json({ type: 1 });
  }

  const parsed = parseDiscordSlashCommand(interaction);
  const response = await handleBotCommand({
    kind: "discord",
    userId: matched.ownerUserId,
    command: parsed.command,
    subcommand: parsed.subcommand,
    args: parsed.args,
  });

  // CHANNEL_MESSAGE_WITH_SOURCE (type 4).
  if (response.kind === "discord") {
    return c.json({
      type: 4,
      data: {
        embeds: response.embeds,
        content: response.content,
        flags: response.ephemeral ? 1 << 6 : 0,
      },
    });
  }
  // Defensive — handleBotCommand should always return the matching kind.
  return c.json({ type: 4, data: { content: "ok" } });
});

// ---------------------------------------------------------------------------
// Install / OAuth completion stubs.
//
// These accept either:
//   * a JSON body with { team_id, channel_id, webhook_url, signing_secret }
//     for direct manual installs from /settings/integrations;
//   * an OAuth `code` exchange (when a real Slack/Discord app is wired up,
//     this code path is the one to extend).
//
// Auth: requires a Gluecron session cookie or PAT; we use the api-v2
// surface's auth (apiAuth runs at the basePath). For the stub we trust the
// caller's `ownerUserId` to be the session user.
// ---------------------------------------------------------------------------

interface InstallBody {
  team_id?: string;
  channel_id?: string;
  webhook_url?: string;
  signing_secret?: string;
}

async function handleInstall(
  kind: "slack" | "discord",
  c: import("hono").Context
) {
  // Minimal auth — read the session cookie / Bearer via api-v2 middleware
  // (we're mounted under the same prefix). The shared apiAuth middleware
  // populates c.get("user"); fall through to 401 if absent.
  // To avoid pulling in the middleware import cycle here, we check both.
  const user = (c.get as (k: string) => unknown)("user") as
    | { id: string }
    | undefined;
  if (!user?.id) return c.json({ error: "auth_required" }, 401);

  let body: InstallBody = {};
  try {
    body = (await c.req.json()) as InstallBody;
  } catch {
    /* allow empty body for placeholder */
  }
  const webhookUrl = (body.webhook_url ?? "").trim();
  if (!webhookUrl) {
    return c.json(
      { error: "missing_webhook_url", hint: "POST a JSON body with webhook_url" },
      400
    );
  }

  const [row] = await db
    .insert(chatIntegrations)
    .values({
      ownerUserId: user.id,
      kind,
      teamId: body.team_id?.trim() || null,
      channelId: body.channel_id?.trim() || null,
      webhookUrl,
      signingSecret: body.signing_secret?.trim() || null,
      enabled: true,
    })
    .onConflictDoNothing()
    .returning();

  return c.json({ ok: true, integration: row ?? null }, 201);
}

r.post("/api/v2/integrations/slack/install", (c) => handleInstall("slack", c));
r.post("/api/v2/integrations/discord/install", (c) =>
  handleInstall("discord", c)
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function looksLikeJson(body: string): boolean {
  const t = body.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

export default r;
