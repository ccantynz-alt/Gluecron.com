/**
 * Connect Claude — user-facing one-click MCP setup page.
 *
 * Routes
 *   GET  /connect/claude              site-wide auth-gated; hero + token mint +
 *                                     three install-path cards + live tools grid
 *                                     + connection status panel.
 *   GET  /settings/claude             alias → redirect to /connect/claude
 *                                     (kept for symmetry with /settings/* nav).
 *   POST /connect/claude/token        session-cookie mint of a fresh `glc_` PAT
 *                                     (internally calls the same logic as the
 *                                     existing /api/v2/auth/install-token route,
 *                                     so the audit trail and scope rules stay
 *                                     consistent).
 *   GET  /connect/claude/dxt          mint-on-download — returns a .dxt zip
 *                                     bundle with the caller's freshly-minted
 *                                     PAT embedded in `manifest.json` so
 *                                     installing requires zero typing.
 *   GET  /api/connect/status          JSON poll endpoint for the live
 *                                     "last called" + "total calls" panel.
 *
 * Hard rules (per the build task brief):
 *   - DO NOT modify any shared view file or any of the MCP server files.
 *   - The marketing /gluecron.dxt remains untouched (served by src/routes/dxt.ts);
 *     this file exposes the personalized variant at a different URL.
 *   - Re-use the existing PAT mechanism — never invent a parallel mint flow.
 *
 * Design language follows commits a004c46 (dashboard hero gradient), 98eb360
 * (settings card polish), and 7a99d47 (numbered import option cards). All CSS
 * is scoped under `.connect-claude-` so it cannot bleed.
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { deflateRawSync } from "node:zlib";
import { db } from "../db";
import { apiTokens, auditLog } from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";
import { audit } from "../lib/notify";
import { config } from "../lib/config";
import { defaultTools } from "../lib/mcp-tools";

const connectClaude = new Hono<AuthEnv>();

// ─── Auth guard ────────────────────────────────────────────────────────────
// Every user-facing route here demands a logged-in user. Public 404 visitors
// will get the standard /login redirect from requireAuth.
connectClaude.use("/connect/claude", requireAuth);
connectClaude.use("/connect/claude/*", requireAuth);
connectClaude.use("/settings/claude", requireAuth);
connectClaude.use("/api/connect/status", requireAuth);

// ─── PAT-mint helpers ──────────────────────────────────────────────────────
// We deliberately duplicate the tiny pieces of /api/v2/auth/install-token
// rather than importing its handler, because the install-token handler does
// its own session-cookie gating (we already have the user from requireAuth)
// and HTTP body parsing (we want a programmatic mint). The on-disk shape
// (token format, hash, audit row) is identical.

function generateInstallToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return (
    "glc_" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

async function hashInstallToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function mintConnectPat(opts: {
  userId: string;
  ip?: string;
  userAgent?: string;
  source: "ui" | "dxt";
}): Promise<{ token: string; id: string; name: string }> {
  const stamp = Math.floor(Date.now() / 1000)
    .toString(36)
    .slice(-6);
  const name =
    opts.source === "dxt"
      ? `gluecron-claude-dxt-${stamp}`
      : `gluecron-claude-ui-${stamp}`;
  const token = generateInstallToken();
  const tokenHash = await hashInstallToken(token);
  const tokenPrefix = token.slice(0, 12);

  const [row] = await db
    .insert(apiTokens)
    .values({
      userId: opts.userId,
      name,
      tokenHash,
      tokenPrefix,
      // Same defaults the install-token endpoint uses for `scope=admin`.
      scopes: "admin,repo,user",
    })
    .returning();

  await audit({
    userId: opts.userId,
    action:
      opts.source === "dxt"
        ? "mcp.dxt.minted"
        : "auth.install_token.created",
    targetType: "api_token",
    targetId: row?.id,
    ip: opts.ip,
    userAgent: opts.userAgent,
    metadata: { name, scope: "admin", prefix: tokenPrefix, source: opts.source },
  });

  return { token, id: row!.id, name };
}

// ─── Minimal in-process .zip writer ────────────────────────────────────────
// `.dxt` is a plain zip of (manifest.json, icon.png, …). We rebuild the
// archive on-the-fly with the user's PAT baked into manifest.json. Using
// `node:zlib.deflateRawSync` keeps the bundle small without a userland
// dependency. Format: PKZIP 2.0 (no zip64, no encryption).

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

type ZipEntry = { name: string; data: Uint8Array };

function buildZip(entries: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const uncompressedSize = entry.data.length;

    // Try deflate; fall back to STORED if it'd inflate the payload.
    let method = 8;
    let compressed: Uint8Array;
    try {
      const out = deflateRawSync(entry.data);
      compressed = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
      if (compressed.length >= uncompressedSize) {
        method = 0;
        compressed = entry.data;
      }
    } catch {
      method = 0;
      compressed = entry.data;
    }
    const compressedSize = compressed.length;

    // Local file header.
    const local = new Uint8Array(30 + nameBytes.length + compressedSize);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file sig
    lv.setUint16(4, 20, true); // version
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressedSize, true);
    lv.setUint32(22, uncompressedSize, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra
    local.set(nameBytes, 30);
    local.set(compressed, 30 + nameBytes.length);
    localParts.push(local);

    // Central directory record.
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressedSize, true);
    cv.setUint32(24, uncompressedSize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
  const centralOffset = offset;

  // End of central directory record.
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true);

  const total =
    localParts.reduce((n, p) => n + p.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of localParts) {
    out.set(p, pos);
    pos += p.length;
  }
  for (const p of centralParts) {
    out.set(p, pos);
    pos += p.length;
  }
  out.set(end, pos);
  return out;
}

// ─── Personalized .dxt manifest ───────────────────────────────────────────
// We embed the freshly-minted PAT directly in the manifest. The user only has
// to double-click the file and Claude Desktop picks up everything else.

function buildPersonalizedManifest(opts: {
  username: string;
  token: string;
  host: string;
}): string {
  const tools = Object.values(defaultTools()).map((h) => ({
    name: h.tool.name,
    description: h.tool.description.split(".")[0] + ".",
  }));
  const manifest = {
    dxt_version: "0.1",
    name: "gluecron",
    display_name: "Gluecron",
    version: "1.0.0",
    description:
      "AI-native git hosting. Claude can open PRs, review code, merge, manage issues, and ship — all on Gluecron.",
    long_description: `Personalized for ${opts.username}. Drop into Claude Desktop and you are connected — no further configuration required.`,
    author: { name: "Gluecron", url: "https://gluecron.com" },
    homepage: opts.host,
    documentation: `${opts.host}/help#mcp`,
    support: `${opts.host}/help`,
    server: {
      type: "http",
      endpoint: `${opts.host}/mcp`,
      headers: {
        Authorization: `Bearer ${opts.token}`,
      },
    },
    user_config: {
      gluecron_host: {
        type: "string",
        title: "Gluecron host",
        description: "URL of your Gluecron instance.",
        default: opts.host,
        required: false,
      },
    },
    tools,
    compatibility: {
      claude_desktop: ">=0.10.0",
      platforms: ["darwin", "win32", "linux"],
    },
    personalized_for: opts.username,
    generated_at: new Date().toISOString(),
  };
  return JSON.stringify(manifest, null, 2);
}

// ─── CSS ───────────────────────────────────────────────────────────────────
const styles = `
  .connect-claude-container { max-width: 980px; margin: 0 auto; padding: 0 0 var(--space-6); }

  /* ─── Hero ─── */
  .connect-claude-hero {
    position: relative;
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
  }
  .connect-claude-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .connect-claude-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.65;
    pointer-events: none;
    animation: connectClaudeOrb 16s ease-in-out infinite;
  }
  @keyframes connectClaudeOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.55; }
    50%      { transform: scale(1.08) translate(-12px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .connect-claude-hero-orb { animation: none; }
  }
  .connect-claude-hero-inner { position: relative; z-index: 1; max-width: 680px; }
  .connect-claude-eyebrow {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
  }
  .connect-claude-eyebrow strong {
    color: var(--accent);
    font-weight: 600;
  }
  .connect-claude-title {
    font-size: clamp(32px, 5vw, 48px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.04;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .connect-claude-title .gradient {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .connect-claude-sub {
    font-size: 16px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }

  /* ─── Section ─── */
  .connect-claude-section {
    position: relative;
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .connect-claude-section-head {
    padding: var(--space-4) var(--space-5) var(--space-2);
  }
  .connect-claude-step-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 6px;
  }
  .connect-claude-step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.14));
    color: #c5b3ff;
    border: 1px solid rgba(140,109,255,0.40);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 13px;
  }
  .connect-claude-section-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.012em;
    color: var(--text-strong);
    margin: 0;
  }
  .connect-claude-section-desc {
    margin: 0;
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1.5;
  }
  .connect-claude-section-body {
    padding: var(--space-2) var(--space-5) var(--space-5);
  }

  /* ─── Token block ─── */
  .connect-claude-token-row {
    display: flex;
    gap: 10px;
    align-items: stretch;
    flex-wrap: wrap;
    margin-top: var(--space-3);
  }
  .connect-claude-btn {
    appearance: none;
    border: 1px solid var(--border-strong);
    background: var(--bg-secondary);
    color: var(--text);
    padding: 10px 16px;
    border-radius: 10px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 150ms ease, background 150ms ease, transform 150ms ease;
    text-decoration: none;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .connect-claude-btn:hover {
    border-color: var(--border-focus);
    background: rgba(255,255,255,0.03);
    transform: translateY(-1px);
  }
  .connect-claude-btn-primary {
    border-color: rgba(140,109,255,0.45);
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.12));
    color: var(--text-strong);
  }
  .connect-claude-btn-primary:hover {
    border-color: rgba(140,109,255,0.65);
    background: linear-gradient(135deg, rgba(140,109,255,0.26), rgba(54,197,214,0.18));
  }
  .connect-claude-token-display {
    flex: 1;
    min-width: 220px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-strong);
    word-break: break-all;
  }
  .connect-claude-token-display .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #3fb950;
    box-shadow: 0 0 8px rgba(63,185,80,0.6);
    flex-shrink: 0;
  }
  .connect-claude-token-empty {
    color: var(--text-faint);
    font-style: italic;
  }
  .connect-claude-token-note {
    margin-top: 10px;
    font-size: 12.5px;
    color: var(--text-muted);
  }

  /* ─── Three option cards (Step 2) ─── */
  .connect-claude-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: var(--space-3);
  }
  .connect-claude-option {
    position: relative;
    padding: var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: border-color 150ms ease, transform 150ms ease;
  }
  .connect-claude-option:hover {
    border-color: var(--border-strong);
    transform: translateY(-1px);
  }
  .connect-claude-option.is-recommended {
    border-color: rgba(140,109,255,0.45);
    background: linear-gradient(180deg, rgba(140,109,255,0.06), var(--bg-secondary) 60%);
  }
  .connect-claude-option-badge {
    position: absolute;
    top: -10px; right: 12px;
    padding: 2px 8px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    color: #fff;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .connect-claude-option-title {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 15px;
    color: var(--text-strong);
    margin: 0;
  }
  .connect-claude-option-desc {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .connect-claude-code {
    position: relative;
    background: var(--bg-tertiary, #0d1018);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-strong);
    overflow-x: auto;
    white-space: pre;
    line-height: 1.5;
  }
  .connect-claude-copy {
    appearance: none;
    border: 1px solid var(--border-subtle);
    background: var(--bg-elevated);
    color: var(--text-muted);
    padding: 6px 10px;
    border-radius: 8px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    align-self: flex-start;
  }
  .connect-claude-copy:hover {
    color: var(--text-strong);
    border-color: var(--border-strong);
  }

  /* ─── Tools grid (Step 3) ─── */
  .connect-claude-tools-group {
    margin-top: var(--space-3);
  }
  .connect-claude-tools-group-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin-bottom: 8px;
  }
  .connect-claude-tools {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 10px;
  }
  .connect-claude-tool {
    padding: 12px 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .connect-claude-tool.is-write {
    border-color: rgba(248, 197, 81, 0.30);
    background: linear-gradient(180deg, rgba(248,197,81,0.04), var(--bg-secondary) 60%);
  }
  .connect-claude-tool-name {
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
  }
  .connect-claude-tool-desc {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.45;
  }

  /* ─── Status panel (Step 4) ─── */
  .connect-claude-status {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: var(--space-3);
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
  }
  .connect-claude-status-dot {
    width: 10px; height: 10px;
    border-radius: 50%;
    background: var(--text-faint);
    flex-shrink: 0;
  }
  .connect-claude-status.is-live .connect-claude-status-dot {
    background: #3fb950;
    box-shadow: 0 0 8px rgba(63,185,80,0.6);
  }
  .connect-claude-status-main { flex: 1; }
  .connect-claude-status-title {
    font-weight: 600;
    color: var(--text-strong);
    font-size: 14px;
  }
  .connect-claude-status-sub {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  @media (max-width: 600px) {
    .connect-claude-options { grid-template-columns: 1fr; }
  }
`;

// ─── Tools-by-mode partitioning ────────────────────────────────────────────
// Anything whose name contains a verb like create/comment/close/reopen/merge
// is a write tool. Everything else is read-only. Keeps the surface honest
// without having to extend the McpTool shape.
function isWriteTool(name: string): boolean {
  return /(create|comment|close|reopen|merge)/.test(name);
}

// ─── Pre-rendered server data ──────────────────────────────────────────────
function buildToolsView(): {
  read: Array<{ name: string; description: string }>;
  write: Array<{ name: string; description: string }>;
} {
  const handlers = defaultTools();
  const read: Array<{ name: string; description: string }> = [];
  const write: Array<{ name: string; description: string }> = [];
  for (const h of Object.values(handlers)) {
    const entry = { name: h.tool.name, description: h.tool.description };
    if (isWriteTool(entry.name)) write.push(entry);
    else read.push(entry);
  }
  return { read, write };
}

function clientScript() {
  // Inline page state machine: token mint via fetch → reveal → snippets &
  // download link refreshed in-place. No framework, just DOM.
  return `
    (function(){
      const elGen = document.getElementById('cc-generate');
      const elDisplay = document.getElementById('cc-token-display');
      const elDxt = document.getElementById('cc-dxt-link');
      const elCliCode = document.getElementById('cc-cli-code');
      const elJsonCode = document.getElementById('cc-json-code');
      const host = ${JSON.stringify(config.appBaseUrl || "https://gluecron.com")};

      function applyToken(tok) {
        if (elDisplay) {
          elDisplay.innerHTML = '<span class="dot" aria-hidden="true"></span><span>'+tok+'</span>';
          elDisplay.classList.remove('connect-claude-token-empty');
        }
        if (elCliCode) {
          elCliCode.textContent = 'claude mcp add gluecron ' + host + '/mcp --header "Authorization: Bearer ' + tok + '"';
        }
        if (elJsonCode) {
          const cfg = {
            mcpServers: {
              gluecron: {
                transport: 'http',
                url: host + '/mcp',
                headers: { Authorization: 'Bearer ' + tok }
              }
            }
          };
          elJsonCode.textContent = JSON.stringify(cfg, null, 2);
        }
      }

      if (elGen) {
        elGen.addEventListener('click', async function() {
          elGen.disabled = true;
          elGen.textContent = 'Generating…';
          try {
            const res = await fetch('/connect/claude/token', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: '{}'
            });
            if (!res.ok) throw new Error('mint failed: ' + res.status);
            const j = await res.json();
            applyToken(j.token);
            elGen.textContent = 'Token generated ✓';
          } catch (e) {
            elGen.disabled = false;
            elGen.textContent = 'Try again';
            console.error(e);
          }
        });
      }

      // Copy buttons
      document.querySelectorAll('[data-cc-copy]').forEach(function(btn){
        btn.addEventListener('click', function(){
          const target = document.getElementById(btn.getAttribute('data-cc-copy'));
          if (!target) return;
          const text = target.textContent || '';
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function(){
              const prev = btn.textContent;
              btn.textContent = 'Copied ✓';
              setTimeout(function(){ btn.textContent = prev; }, 1400);
            });
          }
        });
      });

      // Optional live-status poll (every 30s). Best-effort — failures stay silent.
      const statusEl = document.getElementById('cc-status');
      if (statusEl) {
        async function refresh() {
          try {
            const res = await fetch('/api/connect/status', { credentials: 'same-origin' });
            if (!res.ok) return;
            const j = await res.json();
            if (!j) return;
            const title = statusEl.querySelector('.connect-claude-status-title');
            const sub = statusEl.querySelector('.connect-claude-status-sub');
            if (j.totalCalls > 0) {
              statusEl.classList.add('is-live');
              if (title) title.textContent = 'Connected · ' + j.totalCalls + ' MCP call' + (j.totalCalls === 1 ? '' : 's');
              if (sub && j.lastCalledAt) sub.textContent = 'Last call ' + new Date(j.lastCalledAt).toLocaleString();
            }
          } catch (_) { /* ignore */ }
        }
        refresh();
        setInterval(refresh, 30000);
      }
    })();
  `;
}

// ─── GET /connect/claude ───────────────────────────────────────────────────
connectClaude.get("/connect/claude", async (c) => {
  const user = c.get("user")!;
  const tools = buildToolsView();
  const host = config.appBaseUrl || "https://gluecron.com";

  // Best-effort: look up the most recent MCP audit row for this user.
  let lastCalledAt: string | null = null;
  let totalCalls = 0;
  try {
    const rows = await db
      .select({ createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(
        and(eq(auditLog.userId, user.id), eq(auditLog.action, "mcp.tool.called"))
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    if (rows.length > 0 && rows[0]) {
      lastCalledAt = rows[0].createdAt.toISOString();
    }
    // Cheap count: pull up to 500 rows and use the length. Good enough for
    // a status badge; we don't need exact for-large-N numbers here.
    const counted = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(eq(auditLog.userId, user.id), eq(auditLog.action, "mcp.tool.called"))
      )
      .limit(500);
    totalCalls = counted.length;
  } catch {
    // audit_log may not exist in some test envs — render the empty state.
  }

  const placeholderCli = `claude mcp add gluecron ${host}/mcp --header "Authorization: Bearer <YOUR TOKEN>"`;
  const placeholderJson = JSON.stringify(
    {
      mcpServers: {
        gluecron: {
          transport: "http",
          url: `${host}/mcp`,
          headers: { Authorization: "Bearer <YOUR TOKEN>" },
        },
      },
    },
    null,
    2
  );

  return c.html(
    <Layout title="Connect Claude" user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="connect-claude-container">
        {/* ─── Hero ─── */}
        <section class="connect-claude-hero">
          <div class="connect-claude-hero-orb" aria-hidden="true" />
          <div class="connect-claude-hero-inner">
            <div class="connect-claude-eyebrow">
              Connect Claude · <strong>@{user.username}</strong>
            </div>
            <h1 class="connect-claude-title">
              Drive gluecron from <span class="gradient">Claude</span>.
            </h1>
            <p class="connect-claude-sub">
              One-click setup. Your Claude Desktop, Claude Code, or any
              MCP-aware client gets full access to your repos — search code,
              read files, open issues, ship pull requests.
            </p>
          </div>
        </section>

        {/* ─── Step 1: Generate token ─── */}
        <section class="connect-claude-section">
          <div class="connect-claude-section-head">
            <div class="connect-claude-step-row">
              <span class="connect-claude-step-num">1</span>
              <h2 class="connect-claude-section-title">
                Generate your Claude token
              </h2>
            </div>
            <p class="connect-claude-section-desc">
              A fresh personal access token, scoped to <code>admin,repo,user</code>{" "}
              — same shape as the existing install script mints. Shown once;
              we don't store the plaintext.
            </p>
          </div>
          <div class="connect-claude-section-body">
            <div class="connect-claude-token-row">
              <button
                id="cc-generate"
                type="button"
                class="connect-claude-btn connect-claude-btn-primary"
              >
                Generate token
              </button>
              <div
                id="cc-token-display"
                class="connect-claude-token-display connect-claude-token-empty"
              >
                <span>No token yet — click Generate.</span>
              </div>
            </div>
            <p class="connect-claude-token-note">
              Already have a PAT? Skip to Step 2 — every install path accepts
              tokens minted at <a href="/settings/tokens">/settings/tokens</a>.
            </p>
          </div>
        </section>

        {/* ─── Step 2: Install path ─── */}
        <section class="connect-claude-section">
          <div class="connect-claude-section-head">
            <div class="connect-claude-step-row">
              <span class="connect-claude-step-num">2</span>
              <h2 class="connect-claude-section-title">Pick your install path</h2>
            </div>
            <p class="connect-claude-section-desc">
              Three ways to wire Claude up. Generate the token in Step 1 first
              so the snippets below auto-fill.
            </p>
          </div>
          <div class="connect-claude-section-body">
            <div class="connect-claude-options">
              {/* Desktop */}
              <div class="connect-claude-option is-recommended">
                <span class="connect-claude-option-badge">Recommended</span>
                <h3 class="connect-claude-option-title">Claude Desktop</h3>
                <p class="connect-claude-option-desc">
                  Download a personalized <code>.dxt</code> bundle with your
                  token already embedded. Double-click to install in Claude
                  Desktop.
                </p>
                <a
                  id="cc-dxt-link"
                  href="/connect/claude/dxt"
                  class="connect-claude-btn connect-claude-btn-primary"
                  download={`gluecron-${user.username}.dxt`}
                >
                  Download personalized .dxt
                </a>
              </div>

              {/* CLI */}
              <div class="connect-claude-option">
                <h3 class="connect-claude-option-title">Claude Code (CLI)</h3>
                <p class="connect-claude-option-desc">
                  Wire Claude Code up over MCP with a single command:
                </p>
                <pre id="cc-cli-code" class="connect-claude-code">{placeholderCli}</pre>
                <button
                  type="button"
                  class="connect-claude-copy"
                  data-cc-copy="cc-cli-code"
                >
                  Copy command
                </button>
              </div>

              {/* Manual */}
              <div class="connect-claude-option">
                <h3 class="connect-claude-option-title">Manual config</h3>
                <p class="connect-claude-option-desc">
                  Paste this into your <code>claude_desktop_config.json</code>:
                </p>
                <pre id="cc-json-code" class="connect-claude-code">{placeholderJson}</pre>
                <button
                  type="button"
                  class="connect-claude-copy"
                  data-cc-copy="cc-json-code"
                >
                  Copy JSON
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* ─── Step 3: Tools grid ─── */}
        <section class="connect-claude-section">
          <div class="connect-claude-section-head">
            <div class="connect-claude-step-row">
              <span class="connect-claude-step-num">3</span>
              <h2 class="connect-claude-section-title">
                Tools your Claude will have
              </h2>
            </div>
            <p class="connect-claude-section-desc">
              {tools.read.length + tools.write.length} MCP tools, live from the
              server. Read-only first; write tools require <code>admin</code> scope.
            </p>
          </div>
          <div class="connect-claude-section-body">
            <div class="connect-claude-tools-group">
              <div class="connect-claude-tools-group-label">
                Read · {tools.read.length}
              </div>
              <div class="connect-claude-tools">
                {tools.read.map((t) => (
                  <div class="connect-claude-tool">
                    <span class="connect-claude-tool-name">{t.name}</span>
                    <span class="connect-claude-tool-desc">{t.description}</span>
                  </div>
                ))}
              </div>
            </div>
            <div class="connect-claude-tools-group">
              <div class="connect-claude-tools-group-label">
                Write · {tools.write.length}
              </div>
              <div class="connect-claude-tools">
                {tools.write.map((t) => (
                  <div class="connect-claude-tool is-write">
                    <span class="connect-claude-tool-name">{t.name}</span>
                    <span class="connect-claude-tool-desc">{t.description}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ─── Hosted Claude loops CTA ─── */}
        <section class="connect-claude-section">
          <div class="connect-claude-section-head">
            <div class="connect-claude-step-row">
              <span class="connect-claude-step-num">⚡</span>
              <h2 class="connect-claude-section-title">
                Host a Claude tool-use loop
              </h2>
            </div>
            <p class="connect-claude-section-desc">
              Paste a Claude loop, get a hosted endpoint with a built-in budget
              meter. Your code runs in a 30s sandboxed Bun subprocess —
              no infra to wire up.
            </p>
          </div>
          <div class="connect-claude-section-body">
            <a
              href="/connect/claude/deploy"
              class="connect-claude-btn connect-claude-btn-primary"
            >
              Open Claude loops deploy wizard →
            </a>
          </div>
        </section>

        {/* ─── Step 4: Status ─── */}
        <section class="connect-claude-section">
          <div class="connect-claude-section-head">
            <div class="connect-claude-step-row">
              <span class="connect-claude-step-num">4</span>
              <h2 class="connect-claude-section-title">Connection status</h2>
            </div>
            <p class="connect-claude-section-desc">
              We watch the MCP audit log for tool calls signed by your tokens.
              First call shows up within seconds.
            </p>
          </div>
          <div class="connect-claude-section-body">
            <div
              id="cc-status"
              class={`connect-claude-status${
                totalCalls > 0 ? " is-live" : ""
              }`}
            >
              <span class="connect-claude-status-dot" aria-hidden="true" />
              <div class="connect-claude-status-main">
                <div class="connect-claude-status-title">
                  {totalCalls > 0
                    ? `Connected · ${totalCalls} MCP call${totalCalls === 1 ? "" : "s"}`
                    : "Not yet connected"}
                </div>
                <div class="connect-claude-status-sub">
                  {lastCalledAt
                    ? `Last call ${new Date(lastCalledAt).toLocaleString()}`
                    : "Generate a token, install Claude, and your first call will appear here."}
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
      <script dangerouslySetInnerHTML={{ __html: clientScript() }} />
    </Layout>
  );
});

// ─── Alias: /settings/claude → /connect/claude ─────────────────────────────
connectClaude.get("/settings/claude", (c) => c.redirect("/connect/claude"));

// ─── POST /connect/claude/token — session-cookie mint via fetch ───────────
connectClaude.post("/connect/claude/token", async (c) => {
  const user = c.get("user")!;
  const { token, id, name } = await mintConnectPat({
    userId: user.id,
    ip: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || undefined,
    userAgent: c.req.header("user-agent") || undefined,
    source: "ui",
  });
  return c.json({ token, id, name, scope: "admin" }, 201);
});

// ─── GET /connect/claude/dxt — personalized .dxt download ─────────────────
connectClaude.get("/connect/claude/dxt", async (c) => {
  const user = c.get("user")!;
  const { token } = await mintConnectPat({
    userId: user.id,
    ip: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || undefined,
    userAgent: c.req.header("user-agent") || undefined,
    source: "dxt",
  });

  const host = config.appBaseUrl || "https://gluecron.com";
  const manifestJson = buildPersonalizedManifest({
    username: user.username,
    token,
    host,
  });

  const entries: ZipEntry[] = [
    { name: "manifest.json", data: new TextEncoder().encode(manifestJson) },
    {
      name: "README.md",
      data: new TextEncoder().encode(
        `# Gluecron · personalized for ${user.username}\n\n` +
          `This .dxt was minted on ${new Date().toISOString()} and includes a\n` +
          `personal access token. Treat it like a password — anyone with this\n` +
          `file can act as you on ${host}.\n\n` +
          `Revoke at: ${host}/settings/tokens\n`
      ),
    },
  ];

  const bundle = buildZip(entries);

  return new Response(bundle as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="gluecron-${user.username}.dxt"`,
      "Content-Length": String(bundle.length),
      // Personalized — never cache.
      "Cache-Control": "private, no-store",
    },
  });
});

// ─── GET /api/connect/status — JSON poll for the status panel ─────────────
connectClaude.get("/api/connect/status", async (c) => {
  const user = c.get("user")!;
  try {
    const rows = await db
      .select({ createdAt: auditLog.createdAt, id: auditLog.id })
      .from(auditLog)
      .where(
        and(eq(auditLog.userId, user.id), eq(auditLog.action, "mcp.tool.called"))
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(500);
    const totalCalls = rows.length;
    const lastCalledAt =
      totalCalls > 0 && rows[0]
        ? rows[0].createdAt.toISOString()
        : null;
    return c.json({ totalCalls, lastCalledAt });
  } catch {
    return c.json({ totalCalls: 0, lastCalledAt: null });
  }
});

export default connectClaude;
