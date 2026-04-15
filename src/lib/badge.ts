/**
 * Block J10 — SVG status badges.
 *
 * Render a two-segment "label | value" shields.io-style badge as an inline
 * SVG string. Pure, deterministic, zero IO. Keep this file dependency-free
 * so it can be reused server- or client-side in the future.
 */

export type BadgeColor =
  | "green"
  | "red"
  | "yellow"
  | "blue"
  | "grey"
  | "orange"
  | string;

export interface BadgeInput {
  label: string;
  value: string;
  color?: BadgeColor;
  labelColor?: string;
}

const NAMED_COLORS: Record<string, string> = {
  green: "#2ea043",
  red: "#da3633",
  yellow: "#d29922",
  blue: "#1f6feb",
  grey: "#586069",
  gray: "#586069",
  orange: "#db6d28",
};

function resolveColor(c: BadgeColor | undefined, fallback: string): string {
  if (!c) return fallback;
  if (NAMED_COLORS[c]) return NAMED_COLORS[c];
  if (/^#[0-9a-fA-F]{3,8}$/.test(c)) return c;
  return fallback;
}

/** XML/HTML-safe escape (&, <, >, ", '). */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Rough Verdana-11 width estimator. Good enough for badges without shipping a
 * full font-metrics table. Based on average char widths observed in shields
 * SVGs (~6.5px per char for small DejaVu / Verdana, tighter for narrow chars).
 */
export function estimateTextWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if ("iIl.,:;|!'".includes(ch)) w += 3.5;
    else if ("fjrt".includes(ch)) w += 4.5;
    else if (ch >= "A" && ch <= "Z") w += 7.5;
    else if (ch >= "0" && ch <= "9") w += 6.5;
    else if (ch === " ") w += 3.5;
    else w += 6.2;
  }
  return Math.round(w);
}

/** Build the SVG string for a two-segment badge. */
export function renderBadge(input: BadgeInput): string {
  const label = String(input.label || "").slice(0, 64);
  const value = String(input.value || "").slice(0, 64);
  const valueColor = resolveColor(input.color, NAMED_COLORS.grey);
  const labelColor = resolveColor(input.labelColor, "#555");

  const padding = 10;
  const labelWidth = estimateTextWidth(label) + padding * 2;
  const valueWidth = estimateTextWidth(value) + padding * 2;
  const totalWidth = labelWidth + valueWidth;
  const height = 20;

  const labelEsc = escapeXml(label);
  const valueEsc = escapeXml(value);
  const title = escapeXml(`${label}: ${value}`);

  // Matches shields.io's flat style closely enough to blend into READMEs.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" role="img" aria-label="${title}">
<title>${title}</title>
<linearGradient id="s" x2="0" y2="100%">
<stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
<stop offset="1" stop-opacity=".1"/>
</linearGradient>
<clipPath id="r"><rect width="${totalWidth}" height="${height}" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)">
<rect width="${labelWidth}" height="${height}" fill="${labelColor}"/>
<rect x="${labelWidth}" width="${valueWidth}" height="${height}" fill="${valueColor}"/>
<rect width="${totalWidth}" height="${height}" fill="url(#s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${labelEsc}</text>
<text x="${labelWidth / 2}" y="14">${labelEsc}</text>
<text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${valueEsc}</text>
<text x="${labelWidth + valueWidth / 2}" y="14">${valueEsc}</text>
</g>
</svg>`;
}

/** Pick a colour from a (state, source) pair. Used by route handlers. */
export function colorForState(
  state: "success" | "passed" | "pending" | "failure" | "failed" | "error" | "unknown"
): BadgeColor {
  switch (state) {
    case "success":
    case "passed":
      return "green";
    case "pending":
      return "yellow";
    case "failure":
    case "failed":
    case "error":
      return "red";
    default:
      return "grey";
  }
}
