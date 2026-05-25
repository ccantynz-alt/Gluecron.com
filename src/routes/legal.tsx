/**
 * Legal pages — Terms, Privacy, AUP served from markdown source.
 *
 * The body wraps the rendered markdown in a 2026-style hero card +
 * table of contents + scoped section card. The TOC is parsed from the
 * markdown's `<h2>`s with a tiny regex pass — no shared file touches.
 *
 * All CSS is scoped under `.legal-page-*` so it cannot bleed into the
 * sub-routes under `/legal/terms` etc. (which render their own JSX).
 */

import { Hono } from "hono";
import { readFileSync } from "fs";
import { join } from "path";
import { Layout } from "../views/layout";
import { renderMarkdown, markdownCss } from "../lib/markdown";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { html } from "hono/html";

const legal = new Hono<AuthEnv>();

legal.use("*", softAuth);

// ─── Scoped CSS ─────────────────────────────────────────────────────────────
const legalStyles = `
  .legal-page-wrap {
    max-width: 880px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4);
  }

  /* ─── Hero ─── */
  .legal-page-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .legal-page-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.78;
    pointer-events: none;
  }
  .legal-page-hero-orb {
    position: absolute;
    inset: -22% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .legal-page-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .legal-page-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 14px;
  }
  .legal-page-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .legal-page-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .legal-page-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .legal-page-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }

  /* ─── Table of contents ─── */
  .legal-page-toc {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .legal-page-toc::before {
    content: '';
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 3px;
    background: linear-gradient(180deg, #8c6dff 0%, #36c5d6 100%);
  }
  .legal-page-toc-label {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--accent);
    margin-bottom: var(--space-3);
    font-weight: 600;
  }
  .legal-page-toc-list {
    list-style: none;
    margin: 0;
    padding: 0;
    columns: 2;
    column-gap: 28px;
  }
  @media (max-width: 720px) {
    .legal-page-toc-list { columns: 1; }
  }
  .legal-page-toc-list li {
    margin-bottom: 6px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    break-inside: avoid;
  }
  .legal-page-toc-list a {
    color: var(--text);
    text-decoration: none;
    transition: color 120ms ease;
    display: inline-block;
  }
  .legal-page-toc-list a:hover { color: var(--accent); text-decoration: underline; }
  .legal-page-toc-list .num {
    color: var(--text-faint);
    margin-right: 8px;
    font-variant-numeric: tabular-nums;
  }

  /* ─── Body card ─── */
  .legal-page-body {
    padding: var(--space-6) clamp(var(--space-4), 3vw, var(--space-6));
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
  }
  .legal-page-body .markdown-body { background: transparent; }
  .legal-page-body .markdown-body h1:first-child { display: none; }
  .legal-page-body .markdown-body h2 {
    scroll-margin-top: 72px;
  }

  .legal-page-foot {
    margin-top: var(--space-5);
    padding: var(--space-4);
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    border: 1px dashed var(--border);
    border-radius: 12px;
  }
  .legal-page-foot a {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }
  .legal-page-foot a:hover { text-decoration: underline; }
`;

/**
 * Build a deterministic slug for a heading. Matches the post-process pass
 * below so the TOC anchors hit their targets.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Pull `## Heading` lines from the raw markdown and synth a TOC. Returns an
 * empty list if no h2s are found, in which case the renderer skips the TOC
 * card entirely.
 */
function extractToc(markdown: string): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  const seen = new Map<string, number>();
  const re = /^##\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const text = m[1]!.trim();
    let id = slugify(text);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n}`;
    out.push({ id, text });
  }
  return out;
}

/**
 * Inject `id="..."` into rendered `<h2>` tags so the TOC anchors land.
 * marked doesn't add heading ids out of the box and we don't want to touch
 * the shared `lib/markdown.ts` for a single page.
 */
function addHeadingIds(htmlString: string): string {
  const seen = new Map<string, number>();
  return htmlString.replace(/<h2>([^<]+)<\/h2>/g, (_full, inner) => {
    let id = slugify(inner);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n}`;
    return `<h2 id="${id}">${inner}</h2>`;
  });
}

function getPageMeta(slug: string): { eyebrow: string; title: string; grad: string; sub: string } {
  switch (slug) {
    case "terms":
      return {
        eyebrow: "Legal · Terms of Service",
        title: "The rules we both",
        grad: "agree to.",
        sub: "Last updated April 2026. Plain-English where we can, lawyer-English where we must.",
      };
    case "privacy":
      return {
        eyebrow: "Legal · Privacy Policy",
        title: "What we collect, why,",
        grad: "and how to make us stop.",
        sub: "We collect the minimum we need to run the platform. You can export or delete your data at any time.",
      };
    case "acceptable-use":
      return {
        eyebrow: "Legal · Acceptable Use",
        title: "What you can",
        grad: "build here.",
        sub: "Short list: almost anything. Don't host malware, don't dox people, don't break the law.",
      };
    default:
      return {
        eyebrow: "Legal",
        title: "Policy",
        grad: "document.",
        sub: "",
      };
  }
}

function serveLegalPage(title: string, slug: string, filename: string) {
  return async (c: any) => {
    const user = c.get("user");
    let content: string;
    try {
      content = readFileSync(
        join(process.cwd(), "legal", filename),
        "utf-8"
      );
    } catch {
      content = `# ${title}\n\nThis page is being prepared. Check back soon.`;
    }

    const rendered = addHeadingIds(renderMarkdown(content));
    const toc = extractToc(content);
    const meta = getPageMeta(slug);

    return c.html(
      <Layout title={title} user={user}>
        <style>{markdownCss}</style>
        <style dangerouslySetInnerHTML={{ __html: legalStyles }} />
        <div class={`legal-page-wrap legal-page-${slug}`}>
          {/* ─── Hero ─── */}
          <section class="legal-page-hero">
            <div class="legal-page-hero-orb" aria-hidden="true" />
            <div class="legal-page-hero-inner">
              <div class="legal-page-eyebrow">
                <span class="legal-page-eyebrow-pill" aria-hidden="true">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </span>
                {meta.eyebrow}
              </div>
              <h1 class="legal-page-title">
                {meta.title}{" "}
                <span class="legal-page-title-grad">{meta.grad}</span>
              </h1>
              <p class="legal-page-sub">{meta.sub}</p>
            </div>
          </section>

          {/* ─── Table of contents ─── */}
          {toc.length > 0 && (
            <nav class="legal-page-toc" aria-label="Table of contents">
              <div class="legal-page-toc-label">Contents</div>
              <ol class="legal-page-toc-list">
                {toc.map((item, i) => (
                  <li>
                    <a href={`#${item.id}`}>
                      <span class="num">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {item.text}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          )}

          {/* ─── Body ─── */}
          <article class="legal-page-body">
            <div class="markdown-body">
              {html([rendered] as unknown as TemplateStringsArray)}
            </div>
          </article>

          <div class="legal-page-foot">
            Questions? Email{" "}
            <a href="mailto:legal@gluecron.com">legal@gluecron.com</a>{" "}
            · Other policies:{" "}
            <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> ·{" "}
            <a href="/acceptable-use">AUP</a>
          </div>
        </div>
      </Layout>
    );
  };
}

legal.get("/terms", serveLegalPage("Terms of Service", "terms", "TERMS.md"));
legal.get("/privacy", serveLegalPage("Privacy Policy", "privacy", "PRIVACY.md"));
legal.get("/acceptable-use", serveLegalPage("Acceptable Use Policy", "acceptable-use", "AUP.md"));

export default legal;
