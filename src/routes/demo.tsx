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

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;"
  );
}

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
  // framework. Mirrors the same pattern as `src/lib/sse-client.ts`.
  const pollerScript = `
(function(){try{
  var INTERVAL=${POLL_INTERVAL_MS};
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function rel(iso){try{var ms=Date.now()-new Date(iso).getTime();var s=Math.max(0,Math.floor(ms/1000));if(s<60)return s+'s ago';var m=Math.floor(s/60);if(m<60)return m+'m ago';var h=Math.floor(m/60);if(h<48)return h+'h ago';return Math.floor(h/24)+'d ago';}catch(e){return '';}}
  function pollQueued(){fetch('/api/v2/demo/queued').then(function(r){return r.json();}).then(function(d){
    var el=document.getElementById('tile-queued-list');if(!el)return;
    if(!d.items||d.items.length===0){el.innerHTML='<li class="demo-empty">No queued AI builds — quiet right now.</li>';return;}
    el.innerHTML=d.items.map(function(i){return '<li><a href="/${DEMO_USERNAME}/'+esc(i.repo)+'/issues/'+i.number+'">#'+i.number+' '+esc(i.title)+'</a> <span class="demo-meta">'+esc(i.repo)+' · '+rel(i.createdAt)+'</span></li>';}).join('');
  }).catch(function(){});}
  function pollMerges(){fetch('/api/v2/demo/merges').then(function(r){return r.json();}).then(function(d){
    var el=document.getElementById('tile-merges-list');if(!el)return;
    if(!d.items||d.items.length===0){el.innerHTML='<li class="demo-empty">No auto-merges in the last 24h.</li>';return;}
    el.innerHTML=d.items.map(function(i){return '<li><a href="/${DEMO_USERNAME}/'+esc(i.repo)+'/pulls/'+i.number+'">#'+i.number+' '+esc(i.title)+'</a> <span class="demo-meta">'+esc(i.repo)+' · '+rel(i.mergedAt)+'</span></li>';}).join('');
  }).catch(function(){});}
  function pollReviews(){fetch('/api/v2/demo/reviews').then(function(r){return r.json();}).then(function(d){
    var c=document.getElementById('tile-reviews-count');if(c)c.textContent=String(d.count||0);
    var el=document.getElementById('tile-reviews-list');if(!el)return;
    if(!d.items||d.items.length===0){el.innerHTML='<li class="demo-empty">No AI reviews in the last 24h.</li>';return;}
    el.innerHTML=d.items.map(function(i){return '<li><a href="/${DEMO_USERNAME}/'+esc(i.repo)+'/pulls/'+i.prNumber+'">#'+i.prNumber+'</a> <span class="demo-snippet">'+esc(i.commentSnippet)+'</span> <span class="demo-meta">'+esc(i.repo)+' · '+rel(i.createdAt)+'</span></li>';}).join('');
  }).catch(function(){});}
  function pollFeed(){fetch('/api/v2/demo/activity').then(function(r){return r.json();}).then(function(d){
    var el=document.getElementById('demo-feed-list');if(!el)return;
    if(!d.entries||d.entries.length===0){el.innerHTML='<li class="demo-empty">Quiet right now — push a commit to a demo repo to see live updates.</li>';return;}
    el.innerHTML=d.entries.map(function(e){var label=e.kind==='auto_merge.merged'?'auto-merged':(e.kind==='ai_build.dispatched'?'AI-build dispatched':'AI review posted');var path=e.ref.type==='pr'?'pulls':'issues';return '<li><span class="demo-kind demo-kind-'+esc(e.kind.replace(/\\./g,'-'))+'">'+esc(label)+'</span> <a href="/${DEMO_USERNAME}/'+esc(e.repo)+'/'+path+'/'+e.ref.number+'">'+esc(e.repo)+' #'+e.ref.number+'</a> <span class="demo-meta">'+rel(e.at)+'</span></li>';}).join('');
  }).catch(function(){});}
  function tick(){pollQueued();pollMerges();pollReviews();pollFeed();}
  // Initial refresh after a short delay so the SSR snapshot stays visible
  // a beat — keeps the page from "flashing" identical content on load.
  setInterval(tick,INTERVAL);
}catch(e){}})();
`.trim();

  return c.html(
    <Layout title="Live demo" user={user}>
      <style dangerouslySetInnerHTML={{ __html: DEMO_CSS }} />
      <div class="demo-page">
        <div class="demo-hero">
          <div class="demo-hero-inner">
            <div class="eyebrow">
              <span class="demo-pulse" />
              Live · pulled from production · refreshes every 30s
            </div>
            <h1 class="demo-title">
              Watch Claude <span class="gradient-text">build software, live.</span>
            </h1>
            <p class="demo-sub">
              Every tile below is real audit data from the seeded demo repos.
              File an issue tagged <code>ai:build</code> and the gluecron autopilot
              opens a PR. Land an AI review. Merge it automatically when gates
              go green. No human in the loop for the routine cases.
            </p>
          </div>
          <div class="demo-hero-cta">
            <a href="/register" class="btn btn-primary btn-lg">
              Sign up free <span aria-hidden="true">{"→"}</span>
            </a>
          </div>
        </div>

        <div class="demo-tiles">
          <section class="demo-tile" aria-labelledby="tile-queued-h">
            <h2 id="tile-queued-h" class="demo-tile-title">
              Issues queued for AI build
            </h2>
            <ul id="tile-queued-list" class="demo-list">
              {queued.length === 0 ? (
                <li class="demo-empty">No queued AI builds — quiet right now.</li>
              ) : (
                queued.map((i) => (
                  <li>
                    <a href={`/${DEMO_USERNAME}/${i.repo}/issues/${i.number}`}>
                      #{i.number} {i.title}
                    </a>{" "}
                    <span class="demo-meta">
                      {i.repo} · {relativeTime(i.createdAt)}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </section>

          <section class="demo-tile" aria-labelledby="tile-merges-h">
            <h2 id="tile-merges-h" class="demo-tile-title">
              PRs auto-merged in the last 24h
            </h2>
            <ul id="tile-merges-list" class="demo-list">
              {merges.length === 0 ? (
                <li class="demo-empty">
                  No auto-merges in the last 24h.
                </li>
              ) : (
                merges.map((m) => (
                  <li>
                    <a href={`/${DEMO_USERNAME}/${m.repo}/pulls/${m.number}`}>
                      #{m.number} {m.title}
                    </a>{" "}
                    <span class="demo-meta">
                      {m.repo} · {relativeTime(m.mergedAt)}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </section>

          <section class="demo-tile" aria-labelledby="tile-reviews-h">
            <h2 id="tile-reviews-h" class="demo-tile-title">
              AI reviews posted today
            </h2>
            <div class="demo-bigcount">
              <span id="tile-reviews-count">{reviewCount}</span>
              <span class="demo-bigcount-label">in the last 24h</span>
            </div>
            <ul id="tile-reviews-list" class="demo-list demo-list-small">
              {reviews.length === 0 ? (
                <li class="demo-empty">
                  No AI reviews in the last 24h.
                </li>
              ) : (
                reviews.map((r) => (
                  <li>
                    <a href={`/${DEMO_USERNAME}/${r.repo}/pulls/${r.prNumber}`}>
                      #{r.prNumber}
                    </a>{" "}
                    <span class="demo-snippet">{r.commentSnippet}</span>{" "}
                    <span class="demo-meta">
                      {r.repo} · {relativeTime(r.createdAt)}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </section>
        </div>

        <section class="demo-repos" aria-labelledby="demo-repos-h">
          <h2 id="demo-repos-h" class="demo-section-title">
            Dig into the demo repos
          </h2>
          <div class="demo-repos-grid">
            {demoRepos.map((r) => (
              <a class="demo-repo-card" href={`${demoUserUrl}/${r.name}`}>
                <div class="demo-repo-name">
                  {DEMO_USERNAME}/{r.name}
                </div>
                <div class="demo-repo-tag">{r.tagline}</div>
              </a>
            ))}
          </div>
        </section>

        <section class="demo-feed" aria-labelledby="demo-feed-h">
          <h2 id="demo-feed-h" class="demo-section-title">
            Live activity
          </h2>
          <ul id="demo-feed-list" class="demo-feed-list">
            {feed.length === 0 ? (
              <li class="demo-empty">
                Quiet right now — push a commit to a demo repo to see live updates.
              </li>
            ) : (
              feed.map((e) => {
                const path = e.ref.type === "pr" ? "pulls" : "issues";
                return (
                  <li>
                    <span
                      class={`demo-kind demo-kind-${e.kind.replace(/\./g, "-")}`}
                    >
                      {activityLabel(e.kind)}
                    </span>{" "}
                    <a href={`/${DEMO_USERNAME}/${e.repo}/${path}/${e.ref.number}`}>
                      {e.repo} #{e.ref.number}
                    </a>{" "}
                    <span class="demo-meta">{relativeTime(e.at)}</span>
                  </li>
                );
              })
            )}
          </ul>
        </section>
      </div>
      <script dangerouslySetInnerHTML={{ __html: pollerScript }} />
    </Layout>
  );
});

// Minimal CSS, scoped under .demo-page so it doesn't bleed into other views.
const DEMO_CSS = `
.demo-page { max-width: 1100px; margin: 0 auto; padding: 32px 20px 64px; }
.demo-hero { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; justify-content: space-between; margin-bottom: 32px; }
.demo-hero-inner { flex: 1 1 480px; }
.demo-pulse { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #34d399; box-shadow: 0 0 8px rgba(52,211,153,0.7); margin-right: 8px; vertical-align: middle; animation: demo-pulse 1.6s infinite; }
@keyframes demo-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
.demo-title { font-size: 36px; line-height: 1.1; margin: 12px 0 16px; }
.demo-sub { color: var(--text-muted); max-width: 640px; font-size: 15px; line-height: 1.55; }
.demo-sub code { background: var(--bg-secondary); padding: 1px 6px; border-radius: 4px; font-size: 13px; }
.demo-hero-cta { flex: 0 0 auto; }
.demo-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 32px; }
.demo-tile { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
.demo-tile-title { font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin: 0 0 12px; }
.demo-list { list-style: none; margin: 0; padding: 0; font-size: 14px; line-height: 1.5; }
.demo-list li { padding: 6px 0; border-bottom: 1px solid var(--border); }
.demo-list li:last-child { border-bottom: 0; }
.demo-list-small li { font-size: 13px; }
.demo-list a { color: var(--text-strong); text-decoration: none; }
.demo-list a:hover { text-decoration: underline; }
.demo-meta { color: var(--text-muted); font-size: 12px; }
.demo-snippet { color: var(--text-muted); font-style: italic; font-size: 12px; }
.demo-empty { color: var(--text-muted); font-size: 13px; padding: 6px 0; }
.demo-bigcount { display: flex; align-items: baseline; gap: 8px; margin-bottom: 12px; }
.demo-bigcount span:first-child { font-size: 32px; font-weight: 700; color: var(--text-strong); }
.demo-bigcount-label { color: var(--text-muted); font-size: 12px; }
.demo-section-title { font-size: 18px; margin: 16px 0 12px; }
.demo-repos { margin-bottom: 32px; }
.demo-repos-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.demo-repo-card { display: block; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; text-decoration: none; color: inherit; transition: border-color 0.15s; }
.demo-repo-card:hover { border-color: var(--accent, #8c6dff); }
.demo-repo-name { font-weight: 600; font-size: 14px; color: var(--text-strong); margin-bottom: 4px; }
.demo-repo-tag { font-size: 12px; color: var(--text-muted); }
.demo-feed { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
.demo-feed-list { list-style: none; margin: 0; padding: 0; font-size: 13px; line-height: 1.6; }
.demo-feed-list li { padding: 4px 0; }
.demo-kind { display: inline-block; padding: 1px 7px; border-radius: 9999px; font-size: 11px; font-weight: 500; }
.demo-kind-auto_merge-merged, .demo-kind-auto-merge-merged { background: rgba(52,211,153,0.12); color: #34d399; }
.demo-kind-ai_build-dispatched, .demo-kind-ai-build-dispatched { background: rgba(140,109,255,0.15); color: #8c6dff; }
.demo-kind-ai_review-posted, .demo-kind-ai-review-posted { background: rgba(54,197,214,0.15); color: #36c5d6; }
`;

export default app;
