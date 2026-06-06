/**
 * Block L3 — public `/demo` landing page + companion JSON endpoints.
 *
 * Anonymous-friendly. Demonstrates Gluecron's AI features in real time by
 * surfacing live counts off the audit log + `pr_comments` table for the
 * seeded demo repos.
 *
 * Routes mounted from `src/app.tsx`. Must come BEFORE `routes/admin.tsx`
 * in mount order so this handler wins over the legacy `/demo` redirect.
 *
 *   GET /demo                       → SSR landing page (graceful no-JS,
 *                                     polls JSON endpoints every 30s
 *                                     when JS is available)
 *   GET /api/v2/demo/activity       → combined activity feed JSON
 *   GET /api/v2/demo/queued         → queued ai:build issues JSON
 *   GET /api/v2/demo/merges         → recent auto-merges JSON
 *   GET /api/v2/demo/reviews        → recent AI reviews JSON
 *
 * All JSON endpoints serve `Cache-Control: public, max-age=30` so the demo
 * page is cheap to refresh and external dashboards can embed safely.
 *
 * 2026 polish: scoped `.demo-page-` CSS, four-step interactive walkthrough
 * (mirrors /connect/claude), eyebrow + display headline + 1-line subtitle,
 * 'Try this' prompts on each step, and a reset button on the live feed.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { DEMO_USERNAME } from "../lib/demo-seed";
import {
  countAiReviewsSince,
  listDemoActivityFeed,
  listQueuedAiBuildIssues,
  listRecentAiReviews,
  listRecentAutoMerges,
  type DemoActivityEntry,
} from "../lib/demo-activity";

const app = new Hono<AuthEnv>();

const POLL_INTERVAL_MS = 30_000;

function jsonCacheHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=30",
  };
}

// ───────────────────────────────────────────────────────────────────
// JSON endpoints — cheap, public, cacheable.
// ───────────────────────────────────────────────────────────────────

app.get("/api/v2/demo/activity", async (c) => {
  const feed = await listDemoActivityFeed(20);
  return new Response(
    JSON.stringify({
      entries: feed.map((e) => ({
        kind: e.kind,
        repo: e.repo,
        ref: e.ref,
        at: e.at.toISOString(),
      })),
    }),
    { status: 200, headers: jsonCacheHeaders() }
  );
});

app.get("/api/v2/demo/queued", async (c) => {
  const items = await listQueuedAiBuildIssues(5);
  return new Response(
    JSON.stringify({
      items: items.map((i) => ({
        repo: i.repo,
        number: i.number,
        title: i.title,
        createdAt: i.createdAt.toISOString(),
      })),
    }),
    { status: 200, headers: jsonCacheHeaders() }
  );
});

app.get("/api/v2/demo/merges", async (c) => {
  const items = await listRecentAutoMerges(5, 24);
  return new Response(
    JSON.stringify({
      items: items.map((m) => ({
        repo: m.repo,
        number: m.number,
        title: m.title,
        mergedAt: m.mergedAt.toISOString(),
      })),
    }),
    { status: 200, headers: jsonCacheHeaders() }
  );
});

app.get("/api/v2/demo/reviews", async (c) => {
  const [items, count] = await Promise.all([
    listRecentAiReviews(5, 24),
    countAiReviewsSince(24),
  ]);
  return new Response(
    JSON.stringify({
      count,
      items: items.map((r) => ({
        repo: r.repo,
        prNumber: r.prNumber,
        commentSnippet: r.commentSnippet,
        createdAt: r.createdAt.toISOString(),
      })),
    }),
    { status: 200, headers: jsonCacheHeaders() }
  );
});

// ───────────────────────────────────────────────────────────────────
// HTML landing page.
// ───────────────────────────────────────────────────────────────────

function relativeTime(d: Date): string {
  const ms = Date.now() - d.getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

function activityLabel(kind: DemoActivityEntry["kind"]): string {
  switch (kind) {
    case "auto_merge.merged":
      return "auto-merged";
    case "ai_build.dispatched":
      return "AI-build dispatched";
    case "ai_review.posted":
      return "AI review posted";
  }
}

app.get("/demo", softAuth, async (c) => {
  const user = c.get("user") ?? null;

  // Server-side render the initial snapshot. The JS poller refreshes it
  // every 30s but the no-JS experience still works.
  const [queued, merges, reviewsCountAndList, feed] = await Promise.all([
    listQueuedAiBuildIssues(5),
    listRecentAutoMerges(5, 24),
    Promise.all([listRecentAiReviews(5, 24), countAiReviewsSince(24)]),
    listDemoActivityFeed(20),
  ]);
  const [reviews, reviewCount] = reviewsCountAndList;

  const demoUserUrl = `/${DEMO_USERNAME}`;
  const demoRepos: { name: string; tagline: string }[] = [
    { name: "hello-python", tagline: "Tiny Python app — labels, issues, gates." },
    { name: "todo-api", tagline: "Hono todo API — PRs, AI review, auto-merge." },
    { name: "design-docs", tagline: "ADRs + architecture docs." },
  ];

  // Poller — refreshes the four tiles every 30s. Plain vanilla JS, no
  // framework. Adds a reset action that re-fetches every tile immediately.
  const pollerScript = `
(function(){try{
  var INTERVAL=${POLL_INTERVAL_MS};
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function rel(iso){try{var ms=Date.now()-new Date(iso).getTime();var s=Math.max(0,Math.floor(ms/1000));if(s<60)return s+'s ago';var m=Math.floor(s/60);if(m<60)return m+'m ago';var h=Math.floor(m/60);if(h<48)return h+'h ago';return Math.floor(h/24)+'d ago';}catch(e){return '';}}
  function pollQueued(){fetch('/api/v2/demo/queued').then(function(r){return r.json();}).then(function(d){
    var el=document.getElementById('tile-queued-list');if(!el)return;
    if(!d.items||d.items.length===0){el.innerHTML='<li class="demo-page-empty">Nothing building right now — tag an issue ai:build to watch it start.</li>';return;}
    el.innerHTML=d.items.map(function(i){return '<li><a href="/${DEMO_USERNAME}/'+esc(i.repo)+'/issues/'+i.number+'">#'+i.number+' '+esc(i.title)+'</a> <span class="demo-page-meta">'+esc(i.repo)+' · '+rel(i.createdAt)+'</span></li>';}).join('');
  }).catch(function(){});}
  function pollMerges(){fetch('/api/v2/demo/merges').then(function(r){return r.json();}).then(function(d){
    var el=document.getElementById('tile-merges-list');if(!el)return;
    if(!d.items||d.items.length===0){el.innerHTML='<li class="demo-page-empty">No instant auto-merges yet — one fires the moment gates go green.</li>';return;}
    el.innerHTML=d.items.map(function(i){return '<li><a href="/${DEMO_USERNAME}/'+esc(i.repo)+'/pulls/'+i.number+'">#'+i.number+' '+esc(i.title)+'</a> <span class="demo-page-meta">'+esc(i.repo)+' · '+rel(i.mergedAt)+'</span></li>';}).join('');
  }).catch(function(){});}
  function pollReviews(){fetch('/api/v2/demo/reviews').then(function(r){return r.json();}).then(function(d){
    var c=document.getElementById('tile-reviews-count');if(c)c.textContent=String(d.count||0);
    var el=document.getElementById('tile-reviews-list');if(!el)return;
    if(!d.items||d.items.length===0){el.innerHTML='<li class="demo-page-empty">No AI reviews in the last 24h.</li>';return;}
    el.innerHTML=d.items.map(function(i){return '<li><a href="/${DEMO_USERNAME}/'+esc(i.repo)+'/pulls/'+i.prNumber+'">#'+i.prNumber+'</a> <span class="demo-page-snippet">'+esc(i.commentSnippet)+'</span> <span class="demo-page-meta">'+esc(i.repo)+' · '+rel(i.createdAt)+'</span></li>';}).join('');
  }).catch(function(){});}
  function pollFeed(){fetch('/api/v2/demo/activity').then(function(r){return r.json();}).then(function(d){
    var el=document.getElementById('demo-feed-list');if(!el)return;
    if(!d.entries||d.entries.length===0){el.innerHTML='<li class="demo-page-empty">Quiet right now — push a commit to a demo repo to see live updates.</li>';return;}
    el.innerHTML=d.entries.map(function(e){var label=e.kind==='auto_merge.merged'?'auto-merged':(e.kind==='ai_build.dispatched'?'AI-build dispatched':'AI review posted');var path=e.ref.type==='pr'?'pulls':'issues';return '<li><span class="demo-page-kind demo-page-kind-'+esc(e.kind.replace(/\\./g,'-'))+'">'+esc(label)+'</span> <a href="/${DEMO_USERNAME}/'+esc(e.repo)+'/'+path+'/'+e.ref.number+'">'+esc(e.repo)+' #'+e.ref.number+'</a> <span class="demo-page-meta">'+rel(e.at)+'</span></li>';}).join('');
  }).catch(function(){});}
  function tick(){pollQueued();pollMerges();pollReviews();pollFeed();}
  // Reset button — re-fetch every tile immediately, then flash the button.
  var reset=document.getElementById('demo-reset');
  if(reset){reset.addEventListener('click',function(e){
    e.preventDefault();
    tick();
    var orig=reset.textContent;
    reset.textContent='Refreshed';
    reset.classList.add('is-done');
    setTimeout(function(){reset.textContent=orig;reset.classList.remove('is-done');},1500);
  });}
  // Background polling — initial SSR snapshot stays visible until the
  // first tick fires, so the page doesn't "flash" identical content.
  setInterval(tick,INTERVAL);
}catch(e){}})();
`.trim();

  return c.html(
    <Layout title="Live demo" user={user}>
      <style dangerouslySetInnerHTML={{ __html: DEMO_CSS }} />
      <div class="demo-page">
        {/* ─── Hero ─── */}
        <section class="demo-page-hero">
          <div class="demo-page-hero-orb" aria-hidden="true" />
          <div class="demo-page-hero-inner">
            <div class="demo-page-eyebrow">
              <span class="demo-page-pulse" aria-hidden="true" />
              Live · pulled from production · refreshes every 30s
            </div>
            <h1 class="demo-page-title">
              Watch Claude{" "}
              <span class="demo-page-title-grad">build software, live.</span>
            </h1>
            <p class="demo-page-sub">
              Every tile and step below is real audit data from the seeded
              demo repos. No staging, no mocks.
            </p>
            <div class="demo-page-hero-cta">
              <a href="/register" class="demo-page-btn demo-page-btn-primary">
                Sign up free <span aria-hidden="true">→</span>
              </a>
              <a href={demoUserUrl} class="demo-page-btn">
                Browse the demo user
              </a>
            </div>
          </div>
        </section>

        {/* ─── 4-step interactive walkthrough ─── */}
        <section class="demo-page-section" aria-labelledby="demo-walk-h">
          <header class="demo-page-section-head">
            <div>
              <p class="demo-page-section-eyebrow">Walkthrough</p>
              <h2 class="demo-page-section-title" id="demo-walk-h">
                Four steps. Each one round-trips through production.
              </h2>
              <p class="demo-page-section-sub">
                Click "Try this" on any step to jump into the live demo
                surface that performs it.
              </p>
            </div>
          </header>
          <div class="demo-page-section-body">
            <ol class="demo-page-walk">
              {/* Step 1 — File an ai:build issue */}
              <li class="demo-page-step">
                <div class="demo-page-step-head">
                  <span class="demo-page-step-num">1</span>
                  <span class="demo-page-step-icon" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <line x1="12" y1="8" x2="12" y2="13" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </span>
                  <h3 class="demo-page-step-title">File an issue</h3>
                </div>
                <p class="demo-page-step-body">
                  Open a new issue on any demo repo and tag it{" "}
                  <code>ai:build</code>. The autopilot picks it up in real
                  time — a draft PR appears within 90 seconds.
                </p>
                <p class="demo-page-step-try">
                  <span class="demo-page-try-label">Try this</span>
                  <a
                    class="demo-page-try-link"
                    href={`/${DEMO_USERNAME}/todo-api/issues/new`}
                  >
                    Open the new-issue page →
                  </a>
                </p>
              </li>

              {/* Step 2 — Claude opens a PR */}
              <li class="demo-page-step">
                <div class="demo-page-step-head">
                  <span class="demo-page-step-num">2</span>
                  <span class="demo-page-step-icon" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="6" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <line x1="6" y1="9" x2="6" y2="15" />
                      <path d="M18 9a9 9 0 0 0-9-9" />
                      <circle cx="18" cy="18" r="3" />
                      <line x1="18" y1="9" x2="18" y2="15" />
                    </svg>
                  </span>
                  <h3 class="demo-page-step-title">Claude opens a PR</h3>
                </div>
                <p class="demo-page-step-body">
                  The autopilot reads the issue, edits the repo, opens a
                  branch, and pushes a PR linked back to the issue — all
                  happening right now. Watch it appear in the tile below.
                </p>
                <p class="demo-page-step-try">
                  <span class="demo-page-try-label">Try this</span>
                  <a class="demo-page-try-link" href="#tile-queued-h">
                    See the queue ↓
                  </a>
                </p>
              </li>

              {/* Step 3 — AI review */}
              <li class="demo-page-step">
                <div class="demo-page-step-head">
                  <span class="demo-page-step-num">3</span>
                  <span class="demo-page-step-icon" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                    </svg>
                  </span>
                  <h3 class="demo-page-step-title">AI review lands</h3>
                </div>
                <p class="demo-page-step-body">
                  Every PR gets a second-AI review pass within ~8 seconds
                  of opening — typed comments with line numbers, severity,
                  and a one-line summary at the top. No human needed.
                </p>
                <p class="demo-page-step-try">
                  <span class="demo-page-try-label">Try this</span>
                  <a class="demo-page-try-link" href="#tile-reviews-h">
                    See reviews happening now ↓
                  </a>
                </p>
              </li>

              {/* Step 4 — Auto-merge */}
              <li class="demo-page-step">
                <div class="demo-page-step-head">
                  <span class="demo-page-step-num">4</span>
                  <span class="demo-page-step-icon" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  </span>
                  <h3 class="demo-page-step-title">Auto-merge when green</h3>
                </div>
                <p class="demo-page-step-body">
                  The instant every gate goes green, the autopilot merges
                  the PR and closes the originating issue — no click, no
                  wait. Branch protection rules still apply.
                </p>
                <p class="demo-page-step-try">
                  <span class="demo-page-try-label">Try this</span>
                  <a class="demo-page-try-link" href="#tile-merges-h">
                    Watch it merge in real time ↓
                  </a>
                </p>
              </li>
            </ol>
          </div>
        </section>

        {/* ─── Live tiles ─── */}
        <div class="demo-page-tiles">
          <section class="demo-page-tile" aria-labelledby="tile-queued-h">
            <h2 id="tile-queued-h" class="demo-page-tile-title">
              Issues being built by AI right now
            </h2>
            <ul id="tile-queued-list" class="demo-page-list">
              {queued.length === 0 ? (
                <li class="demo-page-empty">Nothing building right now — tag an issue ai:build to watch it start.</li>
              ) : (
                queued.map((i) => (
                  <li>
                    <a href={`/${DEMO_USERNAME}/${i.repo}/issues/${i.number}`}>
                      #{i.number} {i.title}
                    </a>{" "}
                    <span class="demo-page-meta">
                      {i.repo} · {relativeTime(i.createdAt)}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </section>

          <section class="demo-page-tile" aria-labelledby="tile-merges-h">
            <h2 id="tile-merges-h" class="demo-page-tile-title">
              PRs auto-merged the instant gates passed
            </h2>
            <ul id="tile-merges-list" class="demo-page-list">
              {merges.length === 0 ? (
                <li class="demo-page-empty">
                  No instant auto-merges yet — one fires the moment gates go green.
                </li>
              ) : (
                merges.map((m) => (
                  <li>
                    <a href={`/${DEMO_USERNAME}/${m.repo}/pulls/${m.number}`}>
                      #{m.number} {m.title}
                    </a>{" "}
                    <span class="demo-page-meta">
                      {m.repo} · {relativeTime(m.mergedAt)}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </section>

          <section class="demo-page-tile" aria-labelledby="tile-reviews-h">
            <h2 id="tile-reviews-h" class="demo-page-tile-title">
              AI reviews posted today
            </h2>
            <div class="demo-page-bigcount">
              <span id="tile-reviews-count">{reviewCount}</span>
              <span class="demo-page-bigcount-label">in the last 24h</span>
            </div>
            <ul
              id="tile-reviews-list"
              class="demo-page-list demo-page-list-small"
            >
              {reviews.length === 0 ? (
                <li class="demo-page-empty">
                  No AI reviews in the last 24h.
                </li>
              ) : (
                reviews.map((r) => (
                  <li>
                    <a href={`/${DEMO_USERNAME}/${r.repo}/pulls/${r.prNumber}`}>
                      #{r.prNumber}
                    </a>{" "}
                    <span class="demo-page-snippet">{r.commentSnippet}</span>{" "}
                    <span class="demo-page-meta">
                      {r.repo} · {relativeTime(r.createdAt)}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </section>
        </div>

        <section class="demo-page-section" aria-labelledby="demo-repos-h">
          <header class="demo-page-section-head">
            <div>
              <p class="demo-page-section-eyebrow">Browse</p>
              <h2 class="demo-page-section-title" id="demo-repos-h">
                Dig into the demo repos
              </h2>
            </div>
          </header>
          <div class="demo-page-section-body">
            <div class="demo-page-repos-grid">
              {demoRepos.map((r) => (
                <a class="demo-page-repo-card" href={`${demoUserUrl}/${r.name}`}>
                  <div class="demo-page-repo-name">
                    {DEMO_USERNAME}/{r.name}
                  </div>
                  <div class="demo-page-repo-tag">{r.tagline}</div>
                </a>
              ))}
            </div>
          </div>
        </section>

        <section class="demo-page-section" aria-labelledby="demo-feed-h">
          <header class="demo-page-section-head">
            <div>
              <p class="demo-page-section-eyebrow">Stream</p>
              <h2 class="demo-page-section-title" id="demo-feed-h">
                Live activity
              </h2>
              <p class="demo-page-section-sub">
                Happening right now — newest event first, auto-refreshes every 30s.
              </p>
            </div>
            <button
              type="button"
              id="demo-reset"
              class="demo-page-btn demo-page-reset"
              aria-label="Refresh all tiles now"
            >
              Refresh now
            </button>
          </header>
          <div class="demo-page-section-body">
            <ul id="demo-feed-list" class="demo-page-feed-list">
              {feed.length === 0 ? (
                <li class="demo-page-empty">
                  Quiet right now — push a commit to a demo repo to see
                  live updates.
                </li>
              ) : (
                feed.map((e) => {
                  const path = e.ref.type === "pr" ? "pulls" : "issues";
                  return (
                    <li>
                      <span
                        class={`demo-page-kind demo-page-kind-${e.kind.replace(/\./g, "-")}`}
                      >
                        {activityLabel(e.kind)}
                      </span>{" "}
                      <a href={`/${DEMO_USERNAME}/${e.repo}/${path}/${e.ref.number}`}>
                        {e.repo} #{e.ref.number}
                      </a>{" "}
                      <span class="demo-page-meta">{relativeTime(e.at)}</span>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        </section>
      </div>
      <script dangerouslySetInnerHTML={{ __html: pollerScript }} />
    </Layout>
  );
});

// Scoped CSS — every class prefixed `.demo-page-` so this surface can't
// bleed into other views. Drop-in replacement for the legacy `.demo-*`
// classes; the new prefix is wider so we can polish without collisions.
const DEMO_CSS = `
  .demo-page { max-width: 1680px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Hero ─── */
  .demo-page-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-6) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
  }
  .demo-page-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .demo-page-hero-orb {
    position: absolute;
    inset: -25% -10% auto auto;
    width: 480px; height: 480px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .demo-page-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .demo-page-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .demo-page-pulse {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #34d399;
    box-shadow: 0 0 8px rgba(52,211,153,0.7);
    animation: demo-page-pulse 1.6s infinite;
  }
  @keyframes demo-page-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .demo-page-title {
    font-size: clamp(32px, 5vw, 52px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .demo-page-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .demo-page-sub {
    font-size: 16px;
    color: var(--text-muted);
    margin: 0 0 var(--space-4);
    line-height: 1.55;
    max-width: 620px;
  }
  .demo-page-hero-cta { display: flex; gap: 10px; flex-wrap: wrap; }

  /* ─── Buttons ─── */
  .demo-page-btn {
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
    transition: border-color 150ms ease, background 150ms ease, transform 150ms ease, color 150ms ease;
    text-decoration: none;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .demo-page-btn:hover {
    border-color: var(--border-focus);
    background: rgba(255,255,255,0.03);
    transform: translateY(-1px);
    text-decoration: none;
  }
  .demo-page-btn-primary {
    border-color: rgba(140,109,255,0.45);
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.14));
    color: var(--text-strong);
  }
  .demo-page-btn-primary:hover {
    border-color: rgba(140,109,255,0.65);
    background: linear-gradient(135deg, rgba(140,109,255,0.28), rgba(54,197,214,0.20));
  }
  .demo-page-reset {
    padding: 6px 12px;
    font-size: 12.5px;
    border-radius: 8px;
  }
  .demo-page-reset.is-done {
    border-color: rgba(52,211,153,0.45);
    background: rgba(52,211,153,0.10);
    color: #6ee7b7;
  }

  /* ─── Section cards ─── */
  .demo-page-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .demo-page-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .demo-page-section-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin: 0 0 6px;
  }
  .demo-page-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .demo-page-section-sub {
    margin: 6px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .demo-page-section-body { padding: var(--space-5); }

  /* ─── 4-step walkthrough ─── */
  .demo-page-walk {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: var(--space-3);
  }
  .demo-page-step {
    padding: var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: border-color 150ms ease, transform 150ms ease;
  }
  .demo-page-step:hover {
    border-color: var(--border-strong);
    transform: translateY(-1px);
  }
  .demo-page-step-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .demo-page-step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px; height: 28px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(140,109,255,0.22), rgba(54,197,214,0.16));
    color: #c5b3ff;
    border: 1px solid rgba(140,109,255,0.40);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 13px;
  }
  .demo-page-step-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 8px;
    background: rgba(54,197,214,0.10);
    color: #5fd3e0;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.30);
  }
  .demo-page-step-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.012em;
  }
  .demo-page-step-body {
    margin: 0;
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.55;
  }
  .demo-page-step-body code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--text-strong);
  }
  .demo-page-step-try {
    margin: auto 0 0;
    padding-top: 10px;
    border-top: 1px dashed var(--border-subtle);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12.5px;
  }
  .demo-page-try-label {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .demo-page-try-link {
    color: var(--accent, #8c6dff);
    text-decoration: none;
    font-weight: 600;
  }
  .demo-page-try-link:hover { text-decoration: underline; }

  /* ─── Live tiles ─── */
  .demo-page-tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .demo-page-tile {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4) var(--space-4);
  }
  .demo-page-tile-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    margin: 0 0 12px;
  }
  .demo-page-list {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 14px;
    line-height: 1.5;
  }
  .demo-page-list li {
    padding: 6px 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  .demo-page-list li:last-child { border-bottom: 0; }
  .demo-page-list-small li { font-size: 13px; }
  .demo-page-list a {
    color: var(--text-strong);
    text-decoration: none;
    font-weight: 500;
  }
  .demo-page-list a:hover {
    color: var(--accent, #8c6dff);
    text-decoration: underline;
  }
  .demo-page-meta { color: var(--text-muted); font-size: 12px; }
  .demo-page-snippet { color: var(--text-muted); font-style: italic; font-size: 12px; }
  .demo-page-empty { color: var(--text-muted); font-size: 13px; padding: 6px 0; }
  .demo-page-bigcount {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 12px;
  }
  .demo-page-bigcount span:first-child {
    font-size: 32px;
    font-weight: 700;
    color: var(--text-strong);
    font-family: var(--font-display);
    letter-spacing: -0.02em;
  }
  .demo-page-bigcount-label { color: var(--text-muted); font-size: 12px; }

  /* ─── Demo repos grid ─── */
  .demo-page-repos-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-3);
  }
  .demo-page-repo-card {
    display: block;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    padding: var(--space-3) var(--space-4);
    text-decoration: none;
    color: inherit;
    transition: border-color 150ms ease, transform 150ms ease;
  }
  .demo-page-repo-card:hover {
    border-color: rgba(140,109,255,0.45);
    transform: translateY(-1px);
    text-decoration: none;
  }
  .demo-page-repo-name {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 13.5px;
    color: var(--text-strong);
    margin-bottom: 4px;
  }
  .demo-page-repo-tag {
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }

  /* ─── Live feed ─── */
  .demo-page-feed-list {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 13px;
    line-height: 1.6;
  }
  .demo-page-feed-list li {
    padding: 6px 0;
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .demo-page-feed-list li:last-child { border-bottom: 0; }
  .demo-page-feed-list a {
    color: var(--text-strong);
    text-decoration: none;
    font-weight: 500;
  }
  .demo-page-feed-list a:hover {
    color: var(--accent, #8c6dff);
    text-decoration: underline;
  }
  .demo-page-kind {
    display: inline-flex;
    align-items: center;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .demo-page-kind-auto_merge-merged,
  .demo-page-kind-auto-merge-merged {
    background: rgba(52,211,153,0.12);
    color: #34d399;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.28);
  }
  .demo-page-kind-ai_build-dispatched,
  .demo-page-kind-ai-build-dispatched {
    background: rgba(140,109,255,0.15);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
  }
  .demo-page-kind-ai_review-posted,
  .demo-page-kind-ai-review-posted {
    background: rgba(54,197,214,0.15);
    color: #5fd3e0;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.32);
  }
`;

export default app;
