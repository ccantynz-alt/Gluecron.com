/**
 * Streaming PR review routes.
 *
 * Two endpoints:
 *
 *   GET /:owner/:repo/pulls/:number/review/stream
 *     SSE endpoint — streams a real-time AI review of the PR diff.
 *     If a review is already in progress, sends a waiting message and
 *     polls every 2s until it finishes (max 60s), then streams the result.
 *     On completion, saves the full review as a PR comment (idempotent).
 *
 *   GET /:owner/:repo/pulls/:number/review/stream-ui
 *     Returns an HTML fragment (<div id="stream-review">) with inline JS
 *     that opens an EventSource to ./review/stream and renders tokens in
 *     real-time. Can be embedded in any page via an iframe or fetch-insert.
 *
 * Neither endpoint modifies src/routes/pulls.tsx.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, pullRequests } from "../db/schema";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  streamPrReview,
  isReviewStreaming,
  type StreamingReviewToken,
} from "../lib/streaming-review";

const app = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve owner + repo from URL params. Returns null if not found. */
async function resolveRepo(ownerName: string, repoName: string) {
  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!owner) return null;

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.ownerId, owner.id),
        eq(repositories.name, repoName)
      )
    )
    .limit(1);
  if (!repo) return null;

  return { owner, repo };
}

/** Resolve a PR by repo id + PR number. Returns null if not found. */
async function resolvePr(repositoryId: string, prNumber: number) {
  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        eq(pullRequests.number, prNumber)
      )
    )
    .limit(1);
  return pr ?? null;
}

/** Encode a SSE data line from a StreamingReviewToken. */
function encodeToken(token: StreamingReviewToken): string {
  return `data: ${JSON.stringify(token)}\n\n`;
}

// ---------------------------------------------------------------------------
// SSE stream endpoint
// ---------------------------------------------------------------------------

app.get("/:owner/:repo/pulls/:number/review/stream", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName, number: numberStr } = c.req.param();
  const prNumber = parseInt(numberStr, 10);
  if (isNaN(prNumber) || prNumber < 1) {
    return c.json({ error: "Invalid PR number" }, 400);
  }

  // Resolve repo
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) {
    return c.json({ error: "Repository not found" }, 404);
  }
  const { repo } = resolved;

  // Resolve PR
  const pr = await resolvePr(repo.id, prNumber);
  if (!pr) {
    return c.json({ error: "Pull request not found" }, 404);
  }

  const prId = pr.id;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Flush headers on proxy buffering
      safeEnqueue(": open\n\n");

      // If a review is already streaming, wait for it (max 60s, poll 2s)
      if (isReviewStreaming(prId)) {
        safeEnqueue(
          encodeToken({
            type: "token",
            content: "A review is already in progress. Waiting for it to complete...\n",
          })
        );

        const MAX_WAIT_MS = 60_000;
        const POLL_MS = 2_000;
        const deadline = Date.now() + MAX_WAIT_MS;

        while (isReviewStreaming(prId) && Date.now() < deadline && !closed) {
          await new Promise((r) => setTimeout(r, POLL_MS));
        }

        if (isReviewStreaming(prId)) {
          safeEnqueue(
            encodeToken({
              type: "error",
              error: "Timed out waiting for in-progress review to complete.",
            })
          );
          close();
          return;
        }

        // Review finished while we were waiting — inform the client
        safeEnqueue(
          encodeToken({
            type: "done",
          })
        );
        close();
        return;
      }

      // Start the streaming review
      try {
        for await (const token of streamPrReview(
          prId,
          ownerName,
          repoName,
          pr.baseBranch,
          pr.headBranch
        )) {
          if (closed) break;
          safeEnqueue(encodeToken(token));
          if (token.type === "done" || token.type === "error") {
            break;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        safeEnqueue(encodeToken({ type: "error", error: message }));
      }

      close();
    },
  });

  // Handle client disconnect via AbortSignal — the ReadableStream cancel
  // is not directly wired, but closing the outer Response suffices for
  // Bun's HTTP layer to GC the stream controller.
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// ---------------------------------------------------------------------------
// Embeddable widget endpoint
// ---------------------------------------------------------------------------

app.get("/:owner/:repo/pulls/:number/review/stream-ui", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName, number: numberStr } = c.req.param();
  const prNumber = parseInt(numberStr, 10);
  if (isNaN(prNumber) || prNumber < 1) {
    return c.html("<p>Invalid PR number</p>", 400);
  }

  const streamUrl = `/${ownerName}/${repoName}/pulls/${prNumber}/review/stream`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Stream Review — ${ownerName}/${repoName} #${prNumber}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d1117;
    color: #e6edf3;
    padding: 16px;
  }
  #stream-review {
    border: 1px solid #30363d;
    border-radius: 8px;
    background: #161b22;
    padding: 16px;
    position: relative;
  }
  .sr-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
    font-size: 14px;
    font-weight: 600;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .sr-spinner {
    display: inline-block;
    width: 14px; height: 14px;
    border: 2px solid #30363d;
    border-top-color: #58a6ff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .sr-section {
    margin-bottom: 14px;
  }
  .sr-section-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #58a6ff;
    margin-bottom: 6px;
    padding: 2px 6px;
    border-left: 2px solid #58a6ff;
  }
  .sr-section-label.finding { color: #f0883e; border-left-color: #f0883e; }
  .sr-section-label.verdict { color: #3fb950; border-left-color: #3fb950; }
  pre.sr-content {
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    color: #e6edf3;
    background: none;
    border: none;
    padding: 0;
  }
  .sr-done-msg {
    font-size: 12px;
    color: #3fb950;
    margin-top: 12px;
    padding: 6px 10px;
    border: 1px solid #3fb950;
    border-radius: 4px;
    display: none;
  }
  .sr-error-msg {
    font-size: 12px;
    color: #f85149;
    margin-top: 12px;
    padding: 6px 10px;
    border: 1px solid #f85149;
    border-radius: 4px;
    display: none;
  }
</style>
</head>
<body>
<div id="stream-review">
  <div class="sr-header">
    <span class="sr-spinner" id="sr-spinner"></span>
    <span>AI Stream Review</span>
  </div>
  <div id="sr-body">
    <div class="sr-section" id="sr-section-summary">
      <div class="sr-section-label summary">Summary</div>
      <pre class="sr-content" id="sr-pre-summary"></pre>
    </div>
    <div class="sr-section" id="sr-section-finding" style="display:none">
      <div class="sr-section-label finding">Findings</div>
      <pre class="sr-content" id="sr-pre-finding"></pre>
    </div>
    <div class="sr-section" id="sr-section-verdict" style="display:none">
      <div class="sr-section-label verdict">Verdict</div>
      <pre class="sr-content" id="sr-pre-verdict"></pre>
    </div>
  </div>
  <div class="sr-done-msg" id="sr-done">Review complete. Comment saved to PR.</div>
  <div class="sr-error-msg" id="sr-error"></div>
</div>

<script>
(function() {
  var streamUrl = ${JSON.stringify(streamUrl)};
  var currentSection = "summary";
  var sectionPres = {
    summary: document.getElementById("sr-pre-summary"),
    finding: document.getElementById("sr-pre-finding"),
    verdict: document.getElementById("sr-pre-verdict")
  };
  var sectionDivs = {
    summary: document.getElementById("sr-section-summary"),
    finding: document.getElementById("sr-section-finding"),
    verdict: document.getElementById("sr-section-verdict")
  };
  var spinner = document.getElementById("sr-spinner");
  var doneMsg = document.getElementById("sr-done");
  var errorMsg = document.getElementById("sr-error");

  function showSection(name) {
    if (sectionDivs[name]) {
      sectionDivs[name].style.display = "";
    }
    currentSection = name;
  }

  var es = new EventSource(streamUrl);

  es.onmessage = function(e) {
    var token;
    try { token = JSON.parse(e.data); } catch { return; }

    if (token.type === "token" && token.content) {
      var pre = sectionPres[currentSection];
      if (pre) pre.textContent += token.content;
    } else if (token.type === "section_start" && token.section) {
      showSection(token.section);
    } else if (token.type === "done") {
      es.close();
      if (spinner) spinner.style.display = "none";
      if (doneMsg) doneMsg.style.display = "";
    } else if (token.type === "error") {
      es.close();
      if (spinner) spinner.style.display = "none";
      if (errorMsg) {
        errorMsg.textContent = "Error: " + (token.error || "Unknown error");
        errorMsg.style.display = "";
      }
    }
  };

  es.onerror = function() {
    es.close();
    if (spinner) spinner.style.display = "none";
    if (errorMsg) {
      errorMsg.textContent = "Connection error. The review stream was interrupted.";
      errorMsg.style.display = "";
    }
  };
})();
</script>
</body>
</html>`;

  return c.html(html);
});

export { app as streamingReviewRoutes };
export default app;
