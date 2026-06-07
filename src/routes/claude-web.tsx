/**
 * Block CW — Claude on the web.
 *
 *   GET  /:owner/:repo/claude                   — session list + new-session form
 *   POST /:owner/:repo/claude                   — create session, redirect to detail
 *   GET  /:owner/:repo/claude/:sessionId        — chat UI (messages + composer)
 *   GET  /:owner/:repo/claude/:sessionId/stream — SSE stream of a single turn
 *   POST /:owner/:repo/claude/:sessionId/delete — delete session
 *
 * Open to all authenticated users with at least READ access to the repo
 * (owner, accepted collaborator, or any user for public repos). The page
 * renders server-side with a small inline EventSource client that POSTs
 * nothing — the SSE GET is parameterised by `?prompt=...` so iPad
 * keyboards (no JS fetch issues) just need to follow a link the form
 * submits to. The endpoint persists the user message before opening the
 * stream, so a flaky network mid-stream still leaves the question in the
 * transcript.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { resolveRepoAccess } from "../middleware/repo-access";
import {
  appendMessage,
  createSession,
  deleteSession,
  ensureWorkdir,
  getSession,
  listMessages,
  listSessionsForUser,
  runTurn,
  touchSession,
} from "../lib/claude-web-session";

const claudeWeb = new Hono<AuthEnv>();
claudeWeb.use("*", softAuth);

async function gate(
  c: any
): Promise<{ userId: string; repoId: string; ownerName: string; repoName: string } | Response> {
  const user = c.get("user");
  if (!user) {
    const target = encodeURIComponent(c.req.url);
    return c.redirect(`/login?next=${target}`);
  }
  const ownerName = c.req.param("owner");
  const repoName = c.req.param("repo");
  const [row] = await db
    .select({ id: repositories.id, isPrivate: repositories.isPrivate })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(and(eq(users.username, ownerName), eq(repositories.name, repoName)))
    .limit(1);
  if (!row) return c.notFound();
  const access = await resolveRepoAccess({
    repoId: row.id,
    userId: user.id,
    isPublic: !row.isPrivate,
  });
  if (access === "none") return c.notFound();
  return { userId: user.id, repoId: row.id, ownerName, repoName };
}

const wrap =
  "max-width:980px;margin:24px auto;padding:0 16px;color:#e5e7eb;font-family:system-ui,sans-serif";
const card =
  "background:#0e1117;border:1px solid #1f2937;border-radius:10px;padding:16px 18px;margin-bottom:14px";
const inputStyle =
  "width:100%;background:#0b0e13;border:1px solid #1f2937;color:#e5e7eb;padding:10px 12px;border-radius:6px;font-size:16px";
const btn =
  "background:#1f6feb;border:0;color:#fff;padding:10px 16px;border-radius:6px;cursor:pointer;font-size:15px";

// ─── GET /:owner/:repo/claude ───────────────────────────────────────────────

claudeWeb.get("/:owner/:repo/claude", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const user = c.get("user")!;
  // Show only the current user's sessions for this repo (privacy isolation).
  const sessions = await listSessionsForUser(g.repoId, g.userId);

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      cold: "#374151",
      running: "#1e40af",
      ready: "#14532d",
      failed: "#7f1d1d",
    };
    const bg = colors[status] ?? "#374151";
    return (
      <span
        style={`background:${bg};color:#e5e7eb;font-size:11px;padding:2px 7px;border-radius:10px;font-family:ui-monospace,monospace;vertical-align:middle`}
      >
        {status}
      </span>
    );
  };

  return c.html(
    <Layout title={`Claude — ${g.ownerName}/${g.repoName}`} user={user}>
      <main style={wrap}>
        <p style="margin:0 0 6px">
          <a href={`/${g.ownerName}/${g.repoName}`} style="color:#9ca3af;text-decoration:none">
            ← {g.ownerName}/{g.repoName}
          </a>
        </p>
        <h1 style="margin:0 0 4px;font-size:22px">✨ Claude Code Sessions</h1>
        <p style="margin:0 0 20px;color:#9ca3af;font-size:14px">
          Browser-based Claude Code sessions on a live clone of this repo. Each session
          persists its transcript so you can resume from any device.
        </p>

        <form method="post" action={`/${g.ownerName}/${g.repoName}/claude`} style={card}>
          <label style="display:block;font-size:13px;color:#9ca3af;margin-bottom:8px;font-weight:600">
            Start a new session
          </label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input
              name="title"
              placeholder="What do you want to work on?"
              style={inputStyle + ";flex:1;min-width:180px"}
            />
            <input
              name="branch"
              placeholder="branch (default: main)"
              style={inputStyle + ";max-width:200px"}
            />
            <button type="submit" style={btn}>
              Start session →
            </button>
          </div>
        </form>

        <div style={card}>
          <h2 style="margin:0 0 12px;font-size:15px;color:#cbd5e1">
            Your sessions{sessions.length > 0 ? ` (${sessions.length})` : ""}
          </h2>
          {sessions.length === 0 ? (
            <p style="color:#6b7280;margin:0;font-size:14px">
              No sessions yet. Start one above — Claude will clone the repo and
              open a persistent conversation.
            </p>
          ) : (
            <ul style="list-style:none;padding:0;margin:0">
              {[...sessions].reverse().map((s) => (
                <li style="padding:12px 0;border-top:1px solid #1f2937;display:flex;justify-content:space-between;align-items:center;gap:12px">
                  <a
                    href={`/${g.ownerName}/${g.repoName}/claude/${s.id}`}
                    style="color:#7aa2f7;text-decoration:none;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                  >
                    {s.title}
                  </a>
                  <span style="display:flex;align-items:center;gap:8px;flex-shrink:0;color:#6b7280;font-size:12px;font-family:ui-monospace,monospace">
                    {s.branch}
                    {statusBadge(s.status)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </Layout>
  );
});

// ─── POST /:owner/:repo/claude ──────────────────────────────────────────────

claudeWeb.post("/:owner/:repo/claude", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const form = await c.req.parseBody();
  const title = String(form.title || "").trim() || "New session";
  const branch = String(form.branch || "").trim() || "main";
  const session = await createSession({
    repositoryId: g.repoId,
    ownerUserId: g.userId,
    title,
    branch,
  });
  return c.redirect(`/${g.ownerName}/${g.repoName}/claude/${session.id}`);
});

// ─── GET /:owner/:repo/claude/:sessionId ────────────────────────────────────

claudeWeb.get("/:owner/:repo/claude/:sessionId", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const user = c.get("user")!;
  const sessionId = c.req.param("sessionId");
  const session = await getSession(sessionId, g.userId);
  if (!session || session.repositoryId !== g.repoId) return c.notFound();

  const messages = await listMessages(sessionId);

  // Inline SSE client. ~30 lines of vanilla JS — keeps the bundle empty.
  const clientJs = `
    (function() {
      var f = document.getElementById('cw-composer');
      if (!f) return;
      f.addEventListener('submit', function(ev) {
        ev.preventDefault();
        var input = document.getElementById('cw-prompt');
        var prompt = (input.value || '').trim();
        if (!prompt) return;
        input.value = '';
        var list = document.getElementById('cw-messages');
        var u = document.createElement('div');
        u.className = 'cw-msg cw-msg-user';
        u.textContent = prompt;
        list.appendChild(u);
        var a = document.createElement('pre');
        a.className = 'cw-msg cw-msg-assistant';
        a.textContent = '';
        list.appendChild(a);
        var url = ${JSON.stringify(`/${g.ownerName}/${g.repoName}/claude/${sessionId}/stream`)} + '?prompt=' + encodeURIComponent(prompt);
        var es = new EventSource(url);
        es.addEventListener('chunk', function(e) {
          a.textContent += e.data;
          window.scrollTo(0, document.body.scrollHeight);
        });
        es.addEventListener('done', function() {
          es.close();
        });
        es.addEventListener('error', function() {
          a.textContent += '\\n[stream error — reload to retry]';
          es.close();
        });
      });
    })();
  `;

  const styleCss = `
    .cw-msg { padding:10px 12px;border-radius:8px;margin:8px 0;white-space:pre-wrap;word-wrap:break-word;font-family:ui-monospace,monospace;font-size:14px;line-height:1.5; }
    .cw-msg-user { background:#172033;color:#e5e7eb;border:1px solid #1f6feb55; }
    .cw-msg-assistant { background:#0e1117;color:#cbd5e1;border:1px solid #1f2937; }
    .cw-msg-system { background:#2a1f10;color:#e1c47f;border:1px solid #5a4a1f;font-size:13px; }
  `;

  return c.html(
    <Layout title={`${session.title} — Claude`} user={user}>
      <main style={wrap}>
        <p style="margin:0 0 6px">
          <a href={`/${g.ownerName}/${g.repoName}/claude`} style="color:#9ca3af;text-decoration:none">
            ← Claude sessions
          </a>
        </p>
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <h1 style="margin:0;font-size:20px">{session.title}</h1>
          <span style="color:#6b7280;font-size:12px;font-family:ui-monospace,monospace">
            {session.branch} · {session.status}
          </span>
        </div>
        <style dangerouslySetInnerHTML={{ __html: styleCss }} />

        <div id="cw-messages" style="margin-bottom:14px">
          {messages.length === 0 ? (
            <p style="color:#6b7280;font-size:14px">No turns yet. Ask Claude something below.</p>
          ) : (
            messages.map((m) => (
              <div
                class={"cw-msg cw-msg-" + m.role}
                data-role={m.role}
              >
                {m.body}
              </div>
            ))
          )}
        </div>

        <form id="cw-composer" style={card}>
          <textarea
            id="cw-prompt"
            name="prompt"
            placeholder="Ask Claude..."
            rows={3}
            style={inputStyle}
          />
          <div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center">
            <span style="color:#6b7280;font-size:12px">
              Streams over SSE. Long turns cap at 5 minutes.
            </span>
            <button type="submit" style={btn}>Send</button>
          </div>
        </form>

        <form
          method="post"
          action={`/${g.ownerName}/${g.repoName}/claude/${session.id}/delete`}
          style="text-align:right;margin-top:12px"
          onsubmit="return confirm('Delete this session and its transcript?')"
        >
          <button type="submit" style="background:#a02020;border:0;color:#fff;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px">
            Delete session
          </button>
        </form>

        <script dangerouslySetInnerHTML={{ __html: clientJs }} />
      </main>
    </Layout>
  );
});

// ─── GET /:owner/:repo/claude/:sessionId/stream ─────────────────────────────

claudeWeb.get("/:owner/:repo/claude/:sessionId/stream", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const sessionId = c.req.param("sessionId");
  const session = await getSession(sessionId, g.userId);
  if (!session || session.repositoryId !== g.repoId) return c.notFound();
  const prompt = (c.req.query("prompt") || "").slice(0, 16_000);
  if (!prompt.trim()) {
    return c.text("missing prompt", 400);
  }

  // Persist the user turn *before* we start the stream so a network blip
  // doesn't lose the question.
  await appendMessage({ sessionId, role: "user", body: prompt });
  await touchSession({ sessionId, status: "running" });

  // Lazily clone the workdir on first turn.
  const workdir = await ensureWorkdir(session, g.ownerName, g.repoName);
  if (!workdir.ok) {
    await appendMessage({
      sessionId,
      role: "system",
      body: `workdir error: ${workdir.error}`,
    });
    await touchSession({ sessionId, status: "failed" });
    return c.text(`workdir: ${workdir.error}`, 500);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let assistantBody = "";
      let finalExit = 0;
      let finalDuration = 0;
      let finalClaudeId: string | undefined;

      function send(event: string, data: string) {
        controller.enqueue(enc.encode(`event: ${event}\n`));
        // Split data on newlines so we never break the SSE wire format.
        for (const line of data.split("\n")) {
          controller.enqueue(enc.encode(`data: ${line}\n`));
        }
        controller.enqueue(enc.encode(`\n`));
      }

      try {
        for await (const ev of runTurn({
          session,
          ownerName: g.ownerName,
          repoName: g.repoName,
          prompt,
        })) {
          if (ev.chunk) {
            assistantBody += ev.chunk;
            send("chunk", ev.chunk);
          }
          if (ev.done) {
            finalExit = ev.done.exitCode;
            finalDuration = ev.done.durationMs;
            finalClaudeId = ev.done.claudeSessionId;
            if (ev.done.stderr && ev.done.exitCode !== 0) {
              assistantBody += `\n[stderr] ${ev.done.stderr}`;
              send("chunk", `\n[stderr] ${ev.done.stderr}`);
            }
            send("done", String(ev.done.exitCode));
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        assistantBody += `\n[exception] ${msg}`;
        send("error", msg);
      } finally {
        try {
          await appendMessage({
            sessionId,
            role: "assistant",
            body: assistantBody,
            exitCode: finalExit,
            durationMs: finalDuration,
          });
          await touchSession({
            sessionId,
            claudeSessionId: finalClaudeId,
            status: finalExit === 0 ? "ready" : "failed",
          });
        } catch {
          /* persistence errors don't break the response */
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// ─── POST /:owner/:repo/claude/:sessionId/delete ────────────────────────────

claudeWeb.post("/:owner/:repo/claude/:sessionId/delete", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const sessionId = c.req.param("sessionId");
  const session = await getSession(sessionId, g.userId);
  if (!session || session.repositoryId !== g.repoId) return c.notFound();
  await deleteSession(sessionId);
  return c.redirect(`/${g.ownerName}/${g.repoName}/claude`);
});

export default claudeWeb;
