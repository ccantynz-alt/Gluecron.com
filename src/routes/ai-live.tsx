/**
 * Live AI activity dashboard.
 *
 * `GET /ai/live` renders an HTML shell that:
 *   1. Server-renders the most recent ~50 events + a rollup-by-action card.
 *   2. Subscribes to `/live-events/ai:global` via EventSource and prepends
 *      new events to the timeline as they land.
 *
 * `GET /api/ai/activity` returns the same recent-events list as JSON, so
 * external dashboards / the CLI can poll it.
 *
 * Public read — no AI secrets cross the boundary, only summaries and
 * model/latency/success metadata. Per-repo private context is not exposed
 * here because the flywheel only stores summaries, never prompts.
 */

import { Hono } from "hono";
import { html, raw } from "hono/html";
import { Layout } from "../views/layout";
import { softAuth, type AuthEnv } from "../middleware/auth";
import {
  listRecentAiEvents,
  rollupByAction,
  type AiEvent,
  type RollupRow,
} from "../lib/ai-flywheel";

const app = new Hono<AuthEnv>();

app.get("/ai/live", softAuth, async (c) => {
  const user = c.get("user") ?? null;
  let recent: AiEvent[] = [];
  let rollup: RollupRow[] = [];
  try {
    [recent, rollup] = await Promise.all([
      listRecentAiEvents({ limit: 50 }),
      rollupByAction(24),
    ]);
  } catch {
    /* empty arrays render gracefully */
  }

  const total24h = rollup.reduce((s, r) => s + r.total, 0);
  const fail24h = rollup.reduce((s, r) => s + r.failures, 0);
  const greenRate24h =
    total24h === 0 ? 100 : Math.round(((total24h - fail24h) / total24h) * 100);

  return c.html(
    <Layout title="AI in motion" user={user}>
      <style>{raw(STYLE)}</style>
      <div class="ai-live-page">
        <header class="ai-live-header">
          <div>
            <h1>AI in motion</h1>
            <p class="ai-live-subtitle">
              Every model invocation across gluecron, streamed live.
            </p>
          </div>
          <div class="ai-live-stats">
            <div class="ai-stat">
              <div class="ai-stat-num">{total24h}</div>
              <div class="ai-stat-label">events / 24h</div>
            </div>
            <div class="ai-stat">
              <div class="ai-stat-num">{greenRate24h}%</div>
              <div class="ai-stat-label">success rate</div>
            </div>
            <div class="ai-stat">
              <div class="ai-stat-num" id="ai-live-counter">
                {recent.length}
              </div>
              <div class="ai-stat-label">on screen</div>
            </div>
          </div>
        </header>

        {rollup.length > 0 && (
          <section class="ai-rollup">
            <h2>Last 24h by action</h2>
            <ul class="ai-rollup-list">
              {rollup.map((r) => (
                <li class="ai-rollup-row" data-action={r.actionType}>
                  <span class="ai-rollup-name">{r.actionType}</span>
                  <span class="ai-rollup-num">{r.total}</span>
                  <span class="ai-rollup-bar">
                    <span
                      class="ai-rollup-bar-ok"
                      style={`width:${
                        r.total === 0
                          ? 0
                          : Math.round((r.successes / r.total) * 100)
                      }%`}
                    />
                  </span>
                  <span class="ai-rollup-meta">
                    {r.successes}/{r.total} ok · {r.avgLatencyMs}ms avg
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section class="ai-stream">
          <div class="ai-stream-head">
            <h2>Live stream</h2>
            <span class="ai-conn" id="ai-conn-state">
              <span class="ai-conn-dot" />
              connecting
            </span>
          </div>
          <ul class="ai-events" id="ai-events">
            {recent.length === 0 && (
              <li class="ai-empty">
                Waiting for the first AI event in this process. Push a commit,
                open a PR, or trigger an AI feature to see it appear here.
              </li>
            )}
            {recent.map((e) => (
              <li
                class={`ai-event ${e.success ? "ok" : "fail"}`}
                data-id={e.id}
              >
                {renderEvent(e)}
              </li>
            ))}
          </ul>
        </section>
      </div>
      {raw(SCRIPT)}
    </Layout>
  );
});

app.get("/api/ai/activity", softAuth, async (c) => {
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 50)));
  const repositoryId = c.req.query("repositoryId") || undefined;
  const events = await listRecentAiEvents({ limit, repositoryId });
  return c.json({ events });
});

function renderEvent(e: AiEvent) {
  const when = relTime(e.createdAt);
  return (
    <>
      <div class="ai-event-head">
        <span class={`ai-pill ai-action-${e.actionType}`}>{e.actionType}</span>
        <span class="ai-model">{e.model}</span>
        <span class={`ai-status ${e.success ? "ok" : "fail"}`}>
          {e.success ? "ok" : "fail"}
        </span>
        <span class="ai-latency">{e.latencyMs}ms</span>
        <span class="ai-when">{when}</span>
      </div>
      <div class="ai-event-summary">{e.summary}</div>
      {e.error && <div class="ai-event-error">{e.error}</div>}
    </>
  );
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "just now";
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const STYLE = `
.ai-live-page { max-width: 1100px; margin: 0 auto; padding: 24px; }
.ai-live-header { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 24px; flex-wrap: wrap; }
.ai-live-subtitle { color: var(--text-muted); margin: 4px 0 0; }
.ai-live-stats { display: flex; gap: 16px; }
.ai-stat { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; text-align: center; min-width: 110px; }
.ai-stat-num { font-size: 24px; font-weight: 700; line-height: 1; }
.ai-stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); margin-top: 4px; }
.ai-rollup { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; margin-bottom: 24px; }
.ai-rollup h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); margin: 0 0 12px; }
.ai-rollup-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.ai-rollup-row { display: grid; grid-template-columns: 140px 50px 160px 1fr; align-items: center; gap: 12px; font-size: 13px; }
.ai-rollup-name { font-family: ui-monospace, monospace; color: var(--text); }
.ai-rollup-num { font-weight: 700; text-align: right; }
.ai-rollup-bar { background: rgba(255,255,255,0.06); height: 8px; border-radius: 4px; overflow: hidden; }
.ai-rollup-bar-ok { display: block; height: 100%; background: linear-gradient(90deg, #34d399, #10b981); transition: width .4s ease; }
.ai-rollup-meta { color: var(--text-muted); font-size: 12px; }
.ai-stream-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.ai-stream-head h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); margin: 0; }
.ai-conn { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-muted); }
.ai-conn-dot { width: 8px; height: 8px; border-radius: 50%; background: #facc15; box-shadow: 0 0 8px rgba(250,204,21,.6); animation: pulse 1.4s ease-in-out infinite; }
.ai-conn.ok .ai-conn-dot { background: #34d399; box-shadow: 0 0 8px rgba(52,211,153,.7); }
.ai-conn.fail .ai-conn-dot { background: #f87171; }
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
.ai-events { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.ai-event { background: var(--bg-secondary); border: 1px solid var(--border); border-left: 3px solid #34d399; border-radius: 6px; padding: 10px 14px; transition: background .25s ease, border-color .25s ease; }
.ai-event.fail { border-left-color: #f87171; }
.ai-event.fresh { animation: arrive .55s ease; }
@keyframes arrive { from { transform: translateY(-6px); opacity: 0; background: rgba(52,211,153,.16); } to { transform: translateY(0); opacity: 1; } }
.ai-event-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 12px; }
.ai-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: rgba(99,102,241,.15); color: #a5b4fc; font-family: ui-monospace, monospace; font-size: 11px; text-transform: lowercase; }
.ai-action-repair { background: rgba(34,197,94,.18); color: #86efac; }
.ai-action-incident { background: rgba(248,113,113,.18); color: #fca5a5; }
.ai-action-review { background: rgba(96,165,250,.18); color: #93c5fd; }
.ai-action-completion { background: rgba(168,85,247,.18); color: #d8b4fe; }
.ai-action-explain { background: rgba(244,114,182,.18); color: #f9a8d4; }
.ai-action-test { background: rgba(250,204,21,.18); color: #fcd34d; }
.ai-action-changelog { background: rgba(251,146,60,.18); color: #fdba74; }
.ai-model { font-family: ui-monospace, monospace; color: var(--text-muted); font-size: 11px; }
.ai-status.ok { color: #34d399; font-weight: 600; }
.ai-status.fail { color: #f87171; font-weight: 600; }
.ai-latency { color: var(--text-muted); }
.ai-when { color: var(--text-muted); margin-left: auto; }
.ai-event-summary { font-size: 13px; margin-top: 4px; color: var(--text); }
.ai-event-error { font-family: ui-monospace, monospace; font-size: 11px; color: #fca5a5; margin-top: 4px; }
.ai-empty { background: var(--bg-secondary); border: 1px dashed var(--border); border-radius: 6px; padding: 20px; text-align: center; color: var(--text-muted); }
@media (max-width: 600px) {
  .ai-rollup-row { grid-template-columns: 1fr 50px; }
  .ai-rollup-bar, .ai-rollup-meta { display: none; }
}
`;

const SCRIPT = `<script>
(function(){
  var list = document.getElementById('ai-events');
  var counter = document.getElementById('ai-live-counter');
  var conn = document.getElementById('ai-conn-state');
  if (!list) return;
  var max = 200;
  var es;
  var retry = 1000;

  function setConn(state, label) {
    if (!conn) return;
    conn.classList.remove('ok','fail');
    if (state) conn.classList.add(state);
    var dot = conn.querySelector('.ai-conn-dot');
    conn.innerHTML = '';
    if (dot) conn.appendChild(dot); else { var d = document.createElement('span'); d.className='ai-conn-dot'; conn.appendChild(d); }
    conn.appendChild(document.createTextNode(' ' + label));
  }

  function fmtRel(iso) {
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return 'just now';
    var s = Math.max(0, Math.floor((Date.now()-t)/1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.floor(s/60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m/60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h/24) + 'd ago';
  }

  function pillClass(action) {
    var safe = String(action || '').replace(/[^a-z0-9-]/gi,'').toLowerCase();
    return 'ai-pill ai-action-' + safe;
  }

  function render(ev) {
    var li = document.createElement('li');
    li.className = 'ai-event fresh ' + (ev.success ? 'ok' : 'fail');
    li.setAttribute('data-id', ev.id || '');
    var head = document.createElement('div');
    head.className = 'ai-event-head';
    var pill = document.createElement('span'); pill.className = pillClass(ev.actionType); pill.textContent = ev.actionType || 'other'; head.appendChild(pill);
    var model = document.createElement('span'); model.className = 'ai-model'; model.textContent = ev.model || ''; head.appendChild(model);
    var status = document.createElement('span'); status.className = 'ai-status ' + (ev.success ? 'ok' : 'fail'); status.textContent = ev.success ? 'ok' : 'fail'; head.appendChild(status);
    var lat = document.createElement('span'); lat.className = 'ai-latency'; lat.textContent = (ev.latencyMs || 0) + 'ms'; head.appendChild(lat);
    var when = document.createElement('span'); when.className = 'ai-when'; when.textContent = fmtRel(ev.createdAt); head.appendChild(when);
    li.appendChild(head);
    var summary = document.createElement('div'); summary.className = 'ai-event-summary'; summary.textContent = ev.summary || ''; li.appendChild(summary);
    if (ev.error) {
      var err = document.createElement('div'); err.className = 'ai-event-error'; err.textContent = ev.error; li.appendChild(err);
    }
    return li;
  }

  function prepend(ev) {
    var empty = list.querySelector('.ai-empty');
    if (empty) empty.remove();
    var li = render(ev);
    list.insertBefore(li, list.firstChild);
    while (list.children.length > max) list.removeChild(list.lastChild);
    if (counter) counter.textContent = String(list.children.length);
    setTimeout(function(){ li.classList.remove('fresh'); }, 700);
  }

  function connect() {
    setConn(null, 'connecting');
    try { es = new EventSource('/live-events/ai:global'); } catch(e) { setTimeout(connect, retry); retry = Math.min(retry*2, 30000); return; }
    es.onopen = function(){ setConn('ok','live'); retry = 1000; };
    es.addEventListener('ai', function(e){
      try { var ev = JSON.parse(e.data); prepend(ev); } catch(_) {}
    });
    es.onerror = function(){ setConn('fail','reconnecting'); try { es.close(); } catch(_){}; setTimeout(connect, retry); retry = Math.min(retry*2, 30000); };
  }

  connect();

  // refresh relative timestamps every 15s
  setInterval(function(){
    Array.prototype.forEach.call(list.querySelectorAll('.ai-event'), function(li){
      var when = li.querySelector('.ai-when');
      var head = li.querySelector('.ai-event-head');
      if (!when || !head) return;
      // Skip — we don't carry the iso on the DOM node; only newly streamed events get refresh.
    });
  }, 15000);
})();
</script>`;

export default app;
