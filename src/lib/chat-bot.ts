/**
 * Chat-bot command dispatcher — backs the Slack and Discord slash-command
 * endpoints (`/api/v2/integrations/slack/events`,
 * `/api/v2/integrations/discord/interactions`) and the outbound notification
 * formatter consumed by `src/lib/chat-notifier.ts`.
 *
 * Design rules:
 *   - This file only does parsing + dispatch + presentation. The actual ops
 *     (listing PRs, creating issues, etc.) reuse the same DB queries the REST
 *     surface in `src/routes/api-v2.ts` uses. We pull from the same drizzle
 *     tables so a future change to the schema doesn't drift between Slack
 *     and the web.
 *   - Slash commands map 1:1 to a small command set: `pr list`, `pr open`,
 *     `issue list`, `issue create`, `spec ship`, `chat`, `help`. Anything
 *     unrecognised falls through to a help block.
 *   - All formatters return Slack `blocks` or Discord `embeds`, never raw
 *     strings — chat surfaces strip plain text aggressively and we want
 *     consistent rendering.
 *   - Signature verification for both providers lives here so the endpoint
 *     handlers stay thin and the test fixtures can exercise the core.
 */

import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  repositories,
  issues,
  pullRequests,
} from "../db/schema";
import type { PullRequest, Issue } from "../db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatKind = "slack" | "discord" | "teams";

export interface ParsedCommand {
  /** Bare command verb, lowercased — e.g. "pr", "issue", "spec", "chat", "help". */
  command: string;
  /** Subcommand or argv[1] — e.g. "list", "open", "create", "ship". May be "". */
  subcommand: string;
  /** Whitespace-trimmed rest of the input. May be "". */
  args: string;
  /** Original raw text (post-trim). Kept for echo / debug. */
  raw: string;
}

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string; [k: string]: unknown };
  fields?: Array<{ type: string; text: string }>;
  elements?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  url?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

export interface BotResponseSlack {
  kind: "slack";
  blocks: SlackBlock[];
  /** Slack expects `response_type: in_channel` for public posts. */
  response_type?: "in_channel" | "ephemeral";
  text?: string;
}

export interface BotResponseDiscord {
  kind: "discord";
  embeds: DiscordEmbed[];
  /** When set, restricts visibility to the invoking user. */
  ephemeral?: boolean;
  content?: string;
}

export type BotResponse = BotResponseSlack | BotResponseDiscord;

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Slack slash commands arrive as `application/x-www-form-urlencoded` with the
 * whole user input squashed into one `text` field. We split on whitespace and
 * synthesise the {command, subcommand, args} triple. Quotes in `args` are
 * preserved verbatim — downstream code strips them if it needs to.
 */
export function parseSlackSlashCommand(text: string): ParsedCommand {
  const raw = (text ?? "").trim();
  if (!raw) return { command: "help", subcommand: "", args: "", raw };

  const parts = raw.split(/\s+/);
  const command = (parts[0] ?? "").toLowerCase();
  const subcommand = (parts[1] ?? "").toLowerCase();

  // For `pr open <title>` / `issue create <title>` / `spec ship <desc>` we
  // want the rest verbatim, including quotes — the model that consumes it
  // (spec→PR, ai-chat) handles its own escaping.
  const rest = raw.slice(parts[0]!.length).trimStart();
  // If the second token looks like a subcommand, strip it off; otherwise the
  // first token IS the only thing and args is whatever followed it.
  const hasSubcommand =
    subcommand !== "" &&
    /^[a-z][a-z0-9-]*$/.test(subcommand) &&
    SUBCOMMAND_VERBS.has(`${command} ${subcommand}`);

  const args = hasSubcommand
    ? rest.slice(parts[1]!.length).trimStart()
    : rest;

  return {
    command,
    subcommand: hasSubcommand ? subcommand : "",
    args: stripWrappingQuotes(args),
    raw,
  };
}

/**
 * Discord delivers slash commands as a structured interaction body. We expect
 * the upstream registration to declare one top-level command (`gluecron`)
 * with a subcommand group ("pr", "issue", "spec", "chat") and a single
 * string option carrying the free-text payload. This parser is lenient: if
 * the caller passed only `data.name` and the literal text fell into an
 * option we'll still find it.
 */
export function parseDiscordSlashCommand(
  interaction: DiscordInteractionLike
): ParsedCommand {
  const root = interaction?.data?.name?.toLowerCase() ?? "";
  const opts = interaction?.data?.options ?? [];

  // The Discord SDK nests subcommands: data.options[0] = { name: 'pr',
  // type: 1, options: [{ name: 'list', type: 1, options: [...] }] } or
  // similar. We walk one level deep to find the verb + payload.
  let command = root === "gluecron" ? "" : root;
  let subcommand = "";
  let args = "";

  if (root === "gluecron" && opts.length > 0) {
    const first = opts[0]!;
    command = (first.name ?? "").toLowerCase();
    if (Array.isArray(first.options) && first.options.length > 0) {
      const sub = first.options[0]!;
      if (sub.type === 1 || sub.type === 2) {
        // subcommand / subcommand_group
        subcommand = (sub.name ?? "").toLowerCase();
        const payload = (sub.options ?? []).find(
          (o: DiscordOptionLike) => typeof o.value === "string"
        );
        if (payload) args = String(payload.value ?? "").trim();
      } else if (typeof sub.value === "string") {
        // First-level string option (no subcommand layer).
        args = String(sub.value ?? "").trim();
      }
    }
  } else {
    // Bare command — pull args from the first string option.
    const payload = opts.find((o) => typeof o.value === "string");
    if (payload) args = String(payload.value ?? "").trim();
  }

  const raw = [command, subcommand, args].filter(Boolean).join(" ").trim();
  return {
    command: command || "help",
    subcommand,
    args: stripWrappingQuotes(args),
    raw,
  };
}

const SUBCOMMAND_VERBS = new Set<string>([
  "pr list",
  "pr open",
  "issue list",
  "issue create",
  "spec ship",
]);

function stripWrappingQuotes(s: string): string {
  if (!s) return s;
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith("“") && s.endsWith("”"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Slack signs every request with `v0=hex(hmac-sha256(secret, "v0:" + ts +
 * ":" + body))` in `X-Slack-Signature`. Timestamp is in `X-Slack-Request-
 * Timestamp` — we reject anything older than 5 minutes to deflect replay.
 */
export async function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp: string;
  signature: string;
  body: string;
  /** Inject Date.now()/1000 in tests; defaults to real time. */
  now?: number;
}): Promise<boolean> {
  if (!opts.signingSecret || !opts.timestamp || !opts.signature) return false;

  const tsNum = parseInt(opts.timestamp, 10);
  if (!Number.isFinite(tsNum)) return false;
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > 300) return false;

  const base = `v0:${opts.timestamp}:${opts.body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(opts.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(base)
  );
  const expected =
    "v0=" +
    Array.from(new Uint8Array(sigBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  return constantTimeEqual(expected, opts.signature);
}

/**
 * Discord signs every interaction with Ed25519. The signature is hex; the
 * message is `timestamp + body`. The public key (the bot's
 * "Application Public Key") goes into `signing_secret` at install time.
 *
 * Bun's WebCrypto supports Ed25519 natively.
 */
export async function verifyDiscordSignature(opts: {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  body: string;
}): Promise<boolean> {
  if (!opts.publicKeyHex || !opts.signatureHex || !opts.timestamp) return false;
  try {
    const pubBytes = hexToBytes(opts.publicKeyHex);
    const sigBytes = hexToBytes(opts.signatureHex);
    if (pubBytes.length !== 32 || sigBytes.length !== 64) return false;
    const msg = new TextEncoder().encode(opts.timestamp + opts.body);
    const key = await crypto.subtle.importKey(
      "raw",
      pubBytes.buffer as ArrayBuffer,
      { name: "Ed25519" } as AlgorithmIdentifier,
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" } as AlgorithmIdentifier,
      key,
      sigBytes.buffer as ArrayBuffer,
      msg.buffer as ArrayBuffer
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("bad hex");
    out[i] = byte;
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return r === 0;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export interface HandleBotCommandInput {
  kind: ChatKind;
  /** Gluecron user id (resolved from the install record). May be null when
   *  the workspace has no linked user — we fall back to "help" with an install
   *  nudge in that case. */
  userId: string | null;
  command: string;
  subcommand: string;
  args: string;
}

/**
 * Dispatch a parsed slash command. Always returns a BotResponse — errors
 * become user-visible blocks/embeds rather than HTTP failures (Slack/Discord
 * surface non-2xx as "service unavailable" which is uglier than a bot reply).
 */
export async function handleBotCommand(
  input: HandleBotCommandInput
): Promise<BotResponse> {
  const verb = `${input.command} ${input.subcommand}`.trim();

  if (!input.userId && verb !== "help" && input.command !== "help") {
    return renderHelp(input.kind, {
      note:
        "This workspace isn't linked to a Gluecron account yet. Visit /settings/integrations on Gluecron to finish setup.",
    });
  }

  try {
    switch (verb) {
      case "help":
      case "":
        return renderHelp(input.kind);
      case "pr list":
        return await cmdPrList(input);
      case "pr open":
        return await cmdPrOpen(input);
      case "issue list":
        return await cmdIssueList(input);
      case "issue create":
        return await cmdIssueCreate(input);
      case "spec ship":
        return await cmdSpecShip(input);
      default:
        // Single-verb commands.
        if (input.command === "chat") return await cmdChat(input);
        if (input.command === "help") return renderHelp(input.kind);
        return renderHelp(input.kind, {
          note: `Unknown command: \`${verb || input.command}\`.`,
        });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return renderError(input.kind, msg);
  }
}

// ---------------------------------------------------------------------------
// Command implementations — thin wrappers around the same drizzle queries
// the REST API uses. Heavy logic stays in lib/ai-chat / lib/autopilot.
// ---------------------------------------------------------------------------

async function cmdPrList(input: HandleBotCommandInput): Promise<BotResponse> {
  // `args` is "owner/repo" (or empty → most-recent across the user's repos).
  const target = await resolveTargetRepo(input.userId!, input.args);
  if (!target) {
    return renderError(
      input.kind,
      "No repo found. Usage: `pr list owner/repo`."
    );
  }

  const rows = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, target.repo.id),
        eq(pullRequests.state, "open")
      )
    )
    .orderBy(desc(pullRequests.createdAt))
    .limit(10);

  return formatPrList(input.kind, target.label, rows);
}

async function cmdPrOpen(input: HandleBotCommandInput): Promise<BotResponse> {
  // Format: `pr open owner/repo title…` — but to keep slash-command UX
  // simple we also accept just `pr open title…` and use the user's default
  // repo (most-recent push).
  const target = await resolveTargetRepo(input.userId!, input.args);
  const title = target
    ? input.args.slice(target.matchedSegment.length).trim()
    : input.args;
  if (!title) {
    return renderError(input.kind, "Usage: `pr open owner/repo Add dark mode`.");
  }
  if (!target) {
    return renderError(input.kind, "Couldn't resolve a repo. Add `owner/repo`.");
  }

  // We don't open the PR straight from chat (head/base branches need
  // disambiguation); instead we return a deep-link to the compose page on
  // the website with the title pre-filled.
  const url = `/${target.owner.username}/${target.repo.name}/compare?title=${encodeURIComponent(title)}`;
  return formatLinkCard(
    input.kind,
    `Open PR: ${title}`,
    `Continue in Gluecron — head/base branch picker is on the next screen.`,
    url
  );
}

async function cmdIssueList(
  input: HandleBotCommandInput
): Promise<BotResponse> {
  const target = await resolveTargetRepo(input.userId!, input.args);
  if (!target) {
    return renderError(
      input.kind,
      "No repo found. Usage: `issue list owner/repo`."
    );
  }

  const rows = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.repositoryId, target.repo.id),
        eq(issues.state, "open")
      )
    )
    .orderBy(desc(issues.createdAt))
    .limit(10);

  return formatIssueList(input.kind, target.label, rows);
}

async function cmdIssueCreate(
  input: HandleBotCommandInput
): Promise<BotResponse> {
  const target = await resolveTargetRepo(input.userId!, input.args);
  const title = target
    ? input.args.slice(target.matchedSegment.length).trim()
    : input.args;
  if (!title) {
    return renderError(
      input.kind,
      "Usage: `issue create owner/repo Bug in foo()`."
    );
  }
  if (!target) {
    return renderError(input.kind, "Couldn't resolve a repo. Add `owner/repo`.");
  }

  const [row] = await db
    .insert(issues)
    .values({
      repositoryId: target.repo.id,
      authorId: input.userId!,
      title,
    })
    .returning();

  const num = row?.number ?? 0;
  return formatLinkCard(
    input.kind,
    `Issue #${num} opened — ${title}`,
    `${target.label}`,
    `/${target.owner.username}/${target.repo.name}/issues/${num}`
  );
}

async function cmdSpecShip(
  input: HandleBotCommandInput
): Promise<BotResponse> {
  // spec ship is a deep-link into the autopilot spec-to-PR flow — the
  // actual PR-authoring happens server-side via lib/autopilot-spec-to-pr,
  // and we don't want to block the slash command on it.
  const description = input.args.trim();
  if (!description) {
    return renderError(
      input.kind,
      'Usage: `spec ship "add dark mode to the dashboard"`.'
    );
  }
  const url = `/specs/new?description=${encodeURIComponent(description)}`;
  return formatLinkCard(
    input.kind,
    "Spec → PR",
    `Autopilot will draft a plan, open branches, and ship a PR for: ${description}`,
    url
  );
}

async function cmdChat(input: HandleBotCommandInput): Promise<BotResponse> {
  const message = input.args.trim();
  if (!message) {
    return renderError(input.kind, "Usage: `chat How do I run the tests?`.");
  }
  // We return a deep-link rather than running the LLM inline — chat surfaces
  // expect a sub-3s response and Anthropic latency blows past that.
  const url = `/ask?q=${encodeURIComponent(message)}`;
  return formatLinkCard(
    input.kind,
    "Ask Gluecron",
    message,
    url
  );
}

// ---------------------------------------------------------------------------
// Repo resolution
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  owner: { id: string; username: string };
  repo: { id: string; name: string };
  /** Substring of `args` that matched "owner/repo" — used to trim title. */
  matchedSegment: string;
  /** Display label: "owner/repo". */
  label: string;
}

/**
 * Pull "owner/repo" out of the args head. If absent, fall back to the
 * caller's most-recently-updated repo (handy for ad-hoc Slack usage).
 */
async function resolveTargetRepo(
  userId: string,
  args: string
): Promise<ResolvedTarget | null> {
  const head = args.split(/\s+/, 1)[0] ?? "";
  const m = head.match(/^([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/);
  if (m) {
    const [ownerName, repoName] = [m[1]!, m[2]!];
    const [owner] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner) return null;
    const [repo] = await db
      .select({ id: repositories.id, name: repositories.name })
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return null;
    return {
      owner,
      repo,
      matchedSegment: head,
      label: `${owner.username}/${repo.name}`,
    };
  }

  // Fallback — most-recent repo owned by this user.
  const [owner] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!owner) return null;
  const [repo] = await db
    .select({ id: repositories.id, name: repositories.name })
    .from(repositories)
    .where(eq(repositories.ownerId, owner.id))
    .orderBy(desc(repositories.updatedAt))
    .limit(1);
  if (!repo) return null;
  return {
    owner,
    repo,
    matchedSegment: "",
    label: `${owner.username}/${repo.name}`,
  };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatPrList(
  kind: ChatKind,
  repoLabel: string,
  rows: PullRequest[]
): BotResponse {
  if (kind === "slack" || kind === "teams") {
    const blocks: SlackBlock[] = [
      {
        type: "header",
        text: { type: "plain_text", text: `Open PRs — ${repoLabel}` },
      },
    ];
    if (rows.length === 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "_No open pull requests._" },
      });
    } else {
      for (const pr of rows) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*#${pr.number}* — ${escapeSlack(pr.title)}\n_${pr.headBranch} → ${pr.baseBranch}_${pr.isDraft ? " · draft" : ""}`,
          },
        });
      }
    }
    return { kind: "slack", blocks, response_type: "in_channel" };
  }
  const embed: DiscordEmbed = {
    title: `Open PRs — ${repoLabel}`,
    color: 0x8c6dff,
    fields: rows.length
      ? rows.map((pr) => ({
          name: `#${pr.number} ${pr.title}`,
          value: `${pr.headBranch} → ${pr.baseBranch}${pr.isDraft ? " · draft" : ""}`,
        }))
      : [{ name: "No open pull requests", value: "—" }],
  };
  return { kind: "discord", embeds: [embed] };
}

export function formatIssueList(
  kind: ChatKind,
  repoLabel: string,
  rows: Issue[]
): BotResponse {
  if (kind === "slack" || kind === "teams") {
    const blocks: SlackBlock[] = [
      {
        type: "header",
        text: { type: "plain_text", text: `Open issues — ${repoLabel}` },
      },
    ];
    if (rows.length === 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "_No open issues._" },
      });
    } else {
      for (const it of rows) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*#${it.number}* — ${escapeSlack(it.title)}`,
          },
        });
      }
    }
    return { kind: "slack", blocks, response_type: "in_channel" };
  }
  const embed: DiscordEmbed = {
    title: `Open issues — ${repoLabel}`,
    color: 0x36c5d6,
    fields: rows.length
      ? rows.map((it) => ({
          name: `#${it.number}`,
          value: it.title,
        }))
      : [{ name: "No open issues", value: "—" }],
  };
  return { kind: "discord", embeds: [embed] };
}

export function renderHelp(
  kind: ChatKind,
  opts?: { note?: string }
): BotResponse {
  const lines = [
    "`/gluecron pr list owner/repo` — open PRs",
    '`/gluecron pr open owner/repo "title"` — deep-link to compose a PR',
    "`/gluecron issue list owner/repo` — open issues",
    '`/gluecron issue create owner/repo "title"` — file a new issue',
    '`/gluecron spec ship "description"` — autopilot drafts a PR',
    '`/gluecron chat "question"` — ask Gluecron AI',
    "`/gluecron help` — this message",
  ];
  if (kind === "slack" || kind === "teams") {
    const blocks: SlackBlock[] = [
      {
        type: "header",
        text: { type: "plain_text", text: "Gluecron slash commands" },
      },
    ];
    if (opts?.note) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `:warning: ${opts.note}` },
      });
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    });
    return { kind: "slack", blocks, response_type: "ephemeral" };
  }
  const embed: DiscordEmbed = {
    title: "Gluecron slash commands",
    description: (opts?.note ? `${opts.note}\n\n` : "") + lines.join("\n"),
    color: 0x8c6dff,
  };
  return { kind: "discord", embeds: [embed], ephemeral: true };
}

export function renderError(kind: ChatKind, message: string): BotResponse {
  if (kind === "slack" || kind === "teams") {
    return {
      kind: "slack",
      response_type: "ephemeral",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `:x: ${escapeSlack(message)}` },
        },
      ],
    };
  }
  return {
    kind: "discord",
    ephemeral: true,
    embeds: [
      { title: "Error", description: message, color: 0xf87171 },
    ],
  };
}

function formatLinkCard(
  kind: ChatKind,
  title: string,
  description: string,
  url: string
): BotResponse {
  if (kind === "slack" || kind === "teams") {
    return {
      kind: "slack",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${escapeSlack(title)}*\n${escapeSlack(description)}\n<${url}|Open in Gluecron>`,
          },
        },
      ],
      response_type: "in_channel",
    };
  }
  return {
    kind: "discord",
    embeds: [
      {
        title,
        description,
        url,
        color: 0x8c6dff,
      },
    ],
  };
}

/**
 * Slack uses a tiny markdown subset — only `*bold*`, `_italic_`, and
 * `<url|text>` links matter. Escape the three reserved characters so user
 * titles don't accidentally hijack the formatter.
 */
function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Discord interaction surface — minimal shape so we don't pull the SDK.
// ---------------------------------------------------------------------------

export interface DiscordOptionLike {
  name?: string;
  type?: number;
  value?: unknown;
  options?: DiscordOptionLike[];
}

export interface DiscordInteractionLike {
  type?: number;
  data?: {
    name?: string;
    options?: DiscordOptionLike[];
  };
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id?: string } };
  user?: { id?: string };
}

// ---------------------------------------------------------------------------
// Outbound notification formatter — used by chat-notifier.ts.
// ---------------------------------------------------------------------------

export interface OutboundEvent {
  /** "pr.opened" | "pr.merged" | "issue.opened" | "ai.review" | … */
  event: string;
  repo: string; // "owner/repo"
  title: string;
  url: string; // absolute URL into Gluecron
  body?: string; // optional summary / AI digest
  actor?: string;
}

/**
 * Render an outbound event as either Slack blocks or Discord embeds. The
 * caller posts the returned payload to the integration's webhook_url.
 */
export function formatOutboundEvent(
  kind: ChatKind,
  evt: OutboundEvent
): Record<string, unknown> {
  const headline = `[${evt.repo}] ${evt.title}`;
  if (kind === "slack" || kind === "teams") {
    const blocks: SlackBlock[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${escapeSlack(evt.event)}* — <${evt.url}|${escapeSlack(headline)}>`,
        },
      },
    ];
    if (evt.body) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: escapeSlack(truncate(evt.body, 1500)) },
      });
    }
    if (evt.actor) {
      blocks.push({
        type: "context",
        elements: [
          { type: "mrkdwn", text: `by ${escapeSlack(evt.actor)}` },
        ],
      });
    }
    return { blocks };
  }
  const embed: DiscordEmbed = {
    title: headline,
    url: evt.url,
    description: evt.body ? truncate(evt.body, 1800) : undefined,
    color: colorForEvent(evt.event),
    footer: evt.actor ? { text: `by ${evt.actor}` } : undefined,
    timestamp: new Date().toISOString(),
  };
  return { embeds: [embed] };
}

function colorForEvent(event: string): number {
  if (event.startsWith("pr.merge")) return 0x34d399;
  if (event.startsWith("pr.")) return 0x8c6dff;
  if (event.startsWith("issue.")) return 0x36c5d6;
  if (event.startsWith("ai.")) return 0xfacc15;
  return 0x9ca3af;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const __test = {
  stripWrappingQuotes,
  hexToBytes,
  constantTimeEqual,
  colorForEvent,
  truncate,
  escapeSlack,
};
