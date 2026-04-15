/**
 * Block J19 — Atom feed renderer.
 *
 * Produces a valid Atom 1.0 XML document from a typed description of a
 * feed. Zero-IO, zero dependencies — routes fetch commits/releases/issues
 * from Drizzle and git, shape them into `AtomEntry` rows, then call
 * `renderAtomFeed` to produce the response body.
 *
 * We deliberately avoid pulling in a full XML library: Atom is a small
 * enough format that a careful `escapeXml` + string template is sufficient
 * and leaves no surface for supply-chain surprises.
 */

export interface AtomAuthor {
  name: string;
  email?: string;
}

export interface AtomEntry {
  /** Stable globally-unique ID (e.g. `tag:host,2026:repo/owner/name/commit/<sha>`). */
  id: string;
  title: string;
  /** Canonical permalink for the entry (becomes `<link rel="alternate">`). */
  href: string;
  /** ISO-8601 UTC timestamp. Used for both `<updated>` and `<published>`. */
  updatedAt: string;
  /** Short plaintext summary. Rendered inside `<summary type="text">`. */
  summary?: string;
  /** Optional long-form content. Rendered inside `<content type="html">`. */
  contentHtml?: string;
  author?: AtomAuthor;
}

export interface AtomFeedInput {
  /** Feed-wide unique ID. */
  id: string;
  title: string;
  subtitle?: string;
  /** Absolute URL of the feed itself (becomes `<link rel="self">`). */
  selfHref: string;
  /** Absolute URL of the HTML page the feed represents. */
  alternateHref?: string;
  /** ISO-8601 UTC. Defaults to the newest entry's `updatedAt`, or "now". */
  updatedAt?: string;
  entries: AtomEntry[];
}

/**
 * Escape the five XML special characters so they render safely inside
 * element text + attribute values. Accepts arbitrary input.
 */
export function escapeXml(input: string): string {
  if (!input) return "";
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Coerce an input to a valid ISO-8601 UTC date string. Falls back to the
 * unix epoch if the input can't be parsed — feeds stay valid even with
 * junk inputs.
 */
export function toIsoUtc(input: string | Date | null | undefined): string {
  if (input instanceof Date) {
    const t = input.getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : "1970-01-01T00:00:00.000Z";
  }
  if (typeof input === "string" && input) {
    const t = Date.parse(input);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return "1970-01-01T00:00:00.000Z";
}

function pickFeedUpdated(input: AtomFeedInput): string {
  if (input.updatedAt) return toIsoUtc(input.updatedAt);
  if (input.entries.length > 0) {
    // Pick the newest entry updatedAt.
    let newest = -Infinity;
    for (const e of input.entries) {
      const t = Date.parse(e.updatedAt);
      if (Number.isFinite(t) && t > newest) newest = t;
    }
    if (newest > -Infinity) return new Date(newest).toISOString();
  }
  return new Date().toISOString();
}

function renderAuthor(a: AtomAuthor): string {
  const lines = [`    <name>${escapeXml(a.name || "unknown")}</name>`];
  if (a.email) lines.push(`    <email>${escapeXml(a.email)}</email>`);
  return `  <author>\n${lines.join("\n")}\n  </author>`;
}

function renderEntry(e: AtomEntry): string {
  const parts = [
    "  <entry>",
    `    <id>${escapeXml(e.id)}</id>`,
    `    <title>${escapeXml(e.title || "(untitled)")}</title>`,
    `    <link rel="alternate" href="${escapeXml(e.href)}"/>`,
    `    <updated>${toIsoUtc(e.updatedAt)}</updated>`,
    `    <published>${toIsoUtc(e.updatedAt)}</published>`,
  ];
  if (e.author) {
    parts.push(
      `    <author>`,
      `      <name>${escapeXml(e.author.name || "unknown")}</name>`,
      ...(e.author.email
        ? [`      <email>${escapeXml(e.author.email)}</email>`]
        : []),
      `    </author>`
    );
  }
  if (e.summary) {
    parts.push(
      `    <summary type="text">${escapeXml(e.summary)}</summary>`
    );
  }
  if (e.contentHtml) {
    parts.push(
      `    <content type="html">${escapeXml(e.contentHtml)}</content>`
    );
  }
  parts.push("  </entry>");
  return parts.join("\n");
}

/**
 * Render a full Atom 1.0 document. The output is UTF-8, XML-declaration-
 * prefixed, and safe to return directly with
 * `Content-Type: application/atom+xml; charset=utf-8`.
 */
export function renderAtomFeed(input: AtomFeedInput): string {
  const updated = pickFeedUpdated(input);
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${escapeXml(input.id)}</id>`,
    `  <title>${escapeXml(input.title)}</title>`,
  ];
  if (input.subtitle) {
    lines.push(`  <subtitle>${escapeXml(input.subtitle)}</subtitle>`);
  }
  lines.push(`  <updated>${updated}</updated>`);
  lines.push(`  <link rel="self" href="${escapeXml(input.selfHref)}"/>`);
  if (input.alternateHref) {
    lines.push(
      `  <link rel="alternate" href="${escapeXml(input.alternateHref)}"/>`
    );
  }
  for (const entry of input.entries) {
    lines.push(renderEntry(entry));
  }
  lines.push("</feed>");
  return lines.join("\n") + "\n";
}

/** Mime-type header for Atom responses. */
export const ATOM_CONTENT_TYPE = "application/atom+xml; charset=utf-8";

export const __internal = {
  escapeXml,
  toIsoUtc,
  pickFeedUpdated,
  renderAuthor,
  renderEntry,
  renderAtomFeed,
  ATOM_CONTENT_TYPE,
};
