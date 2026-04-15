/**
 * Block G2 — GraphQL HTTP endpoint.
 *
 *   POST /api/graphql   — execute { query } against the schema in `lib/graphql`
 *   GET  /api/graphql   — minimal in-browser "GraphiQL-lite" explorer
 *
 * Auth: softAuth only — the schema is queries-only and every resolver enforces
 * visibility (only public repos surface for logged-out viewers). Writes live on
 * the REST + /api endpoints.
 */

import { Hono } from "hono";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { execute } from "../lib/graphql";

const graphql = new Hono<AuthEnv>();
graphql.use("*", softAuth);

graphql.post("/api/graphql", async (c) => {
  let body: { query?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errors: [{ message: "Invalid JSON body" }] }, 400);
  }
  const q = String(body.query || "");
  if (!q.trim()) {
    return c.json({ errors: [{ message: "query is required" }] }, 400);
  }
  const user = c.get("user") || null;
  const result = await execute(q, { user: user ? { id: user.id, username: user.username } : null });
  return c.json(result);
});

graphql.get("/api/graphql", (c) => {
  const sample = `query {
  viewer { id username email }
  search(q: "ai", limit: 5) { id name ownerUsername }
  rateLimit { remaining reset }
}`;
  const html = `<!doctype html>
<html><head><meta charset="UTF-8" /><title>Gluecron GraphQL</title>
<style>
  body { background:#0d1117; color:#e6edf3; font-family:system-ui,sans-serif; margin:0; padding:20px; }
  h1 { font-size:18px; margin:0 0 12px; }
  .layout { display:grid; grid-template-columns:1fr 1fr; gap:12px; height:85vh; }
  textarea, pre {
    background:#161b22; color:#e6edf3; border:1px solid #30363d; border-radius:6px;
    padding:12px; font-family:monospace; font-size:13px; width:100%; height:100%;
    box-sizing:border-box; resize:none;
  }
  pre { overflow:auto; white-space:pre-wrap; }
  button {
    background:#238636; color:#fff; border:0; border-radius:6px;
    padding:8px 16px; font-weight:600; cursor:pointer; margin-bottom:8px;
  }
  a { color:#58a6ff; }
</style>
</head><body>
<h1>gluecron · GraphQL <a href="/">home</a></h1>
<button onclick="run()">Run (Ctrl+Enter)</button>
<div class="layout">
  <textarea id="q" spellcheck="false">${sample.replace(/</g, "&lt;")}</textarea>
  <pre id="r">{ "hint": "Click Run" }</pre>
</div>
<script>
async function run(){
  const q = document.getElementById('q').value;
  document.getElementById('r').textContent = 'Loading…';
  try {
    const r = await fetch('/api/graphql', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({ query: q }),
      credentials:'include'
    });
    const j = await r.json();
    document.getElementById('r').textContent = JSON.stringify(j, null, 2);
  } catch (e) {
    document.getElementById('r').textContent = String(e);
  }
}
document.getElementById('q').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
});
</script>
</body></html>`;
  c.header("content-type", "text/html; charset=utf-8");
  return c.body(html);
});

export default graphql;
