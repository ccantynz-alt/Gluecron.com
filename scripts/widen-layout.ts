/**
 * One-shot layout-widening sweep.
 *
 * The site felt "thin": `main` allowed 1440px but nearly every page wrapped its
 * content in a much narrower centered column (880–1180px), leaving big empty
 * gutters on modern wide screens. This script widens the per-page container
 * declarations into consistent tiers so the whole site uses the available
 * width the way GitHub / Linear / Vercel do.
 *
 * It is deliberately conservative: it only rewrites a CSS declaration line when
 * that line is unmistakably a page-level container — i.e. the selector is a
 * class whose name ends in `-wrap`, `-container`, or `-page`, AND the same line
 * sets both `max-width: <N>px` and `margin: 0 auto`. Hero-inner / sub-heading /
 * media-query widths never match (no `margin: 0 auto`), so prose measure and
 * narrow confirm dialogs are left intact.
 *
 * Tiers (pass 2 — "do it all", near-full-bleed):
 *   >= 1300px  -> 1680  (dashboards, lists, tables, admin, explore, insights)
 *   1080..1299 -> 1320  (medium pages)
 *   1000..1079 -> 1200  (settings, repo-settings, import, forms)
 *   740..819   -> 900   (small confirm/detail cards, gentle nudge)
 *   else       -> unchanged (tiny claim/dialog views < 740px stay compact)
 *
 * Run once: `bun scripts/widen-layout.ts`
 */

import { Glob } from "bun";

const ROOT = new URL("..", import.meta.url).pathname;

function widen(old: number): number | null {
  if (old >= 1300) return 1680;
  if (old >= 1080) return 1320;
  if (old >= 1000) return 1200;
  if (old >= 740 && old < 820) return 900;
  return null; // leave tiny intentional widths alone
}

// Matches a single-line page-container declaration, capturing the px width.
// Example: `  .admin-wrap { max-width: 1080px; margin: 0 auto; }`
const LINE_RE =
  /^(\s*\.[A-Za-z0-9_-]*(?:wrap|container|page)\b[^\n{]*\{[^\n}]*max-width:\s*)(\d+)(px[^\n]*margin:\s*0 auto[^\n]*)$/;

const glob = new Glob("src/**/*.tsx");
let filesChanged = 0;
let linesChanged = 0;

for await (const rel of glob.scan({ cwd: ROOT })) {
  if (!rel.startsWith("src/routes/") && !rel.startsWith("src/views/")) continue;
  const path = ROOT + rel;
  const src = await Bun.file(path).text();
  const lines = src.split("\n");
  let touched = false;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE_RE);
    if (!m) continue;
    const old = parseInt(m[2], 10);
    const next = widen(old);
    if (next === null || next === old) continue;
    lines[i] = `${m[1]}${next}${m[3]}`;
    console.log(`${rel}:${i + 1}  ${old}px -> ${next}px`);
    touched = true;
    linesChanged++;
  }

  if (touched) {
    await Bun.write(path, lines.join("\n"));
    filesChanged++;
  }
}

console.log(`\nDone: ${linesChanged} container(s) widened across ${filesChanged} file(s).`);
