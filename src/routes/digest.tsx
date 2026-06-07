/**
 * /digest — Smart Morning Digest page.
 *
 * GET  /digest         — personal AI-curated digest (requireAuth)
 * POST /digest/refresh — regenerate digest for current user, then redirect
 *
 * Shows the user's most recent digest notification (type='digest') or
 * auto-generates one on first load. Displays:
 *   - AI-written headline
 *   - Priority-sorted queue (blocking=red, important=amber, fyi=grey)
 *   - Stats row (PRs reviewed / issues closed / commits)
 *   - Optional AI insight
 *   - "Regenerate" button
 */

import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { notifications, users } from "../db/schema";
import { Layout } from "../views/layout";
import { requireAuth, softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { composeSmartDigest, sendSmartDigest, type SmartDigest, type DigestItem } from "../lib/smart-digest";
import { formatRelative } from "../views/ui";

const digest = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const DIGEST_STYLES = `
  .digest-hero {
    position: relative;
    margin: 0 0 var(--space-5, 24px);
    padding: 24px 28px 26px;
    background: var(--bg-elevated, #f8f9fa);
    border: 1px solid var(--border, #e1e4e8);
    border-radius: 16px;
    overflow: hidden;
  }
  .digest-hero::before {
    content: '';
    position: absolute; top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #f7971e 30%, #ffd200 70%, transparent 100%);
    opacity: 0.8;
    pointer-events: none;
  }
  .digest-hero-icon {
    font-size: 28px;
    margin-bottom: 10px;
    display: block;
  }
  .digest-headline {
    font-size: clamp(20px, 2.8vw, 28px);
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--text-strong, #111);
    margin: 0 0 8px;
    line-height: 1.15;
  }
  .digest-meta {
    font-size: 12.5px;
    color: var(--text-muted, #777);
    margin: 0;
  }
  .digest-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 16px;
  }
  .digest-regenerate-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    background: var(--bg, #fff);
    border: 1px solid var(--border, #e1e4e8);
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text, #333);
    cursor: pointer;
    text-decoration: none;
  }
  .digest-regenerate-btn:hover {
    background: var(--bg-elevated, #f8f9fa);
    border-color: var(--accent, #0070f3);
  }

  /* Queue */
  .digest-queue {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 24px;
  }
  .digest-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--bg-elevated, #f8f9fa);
    border: 1px solid var(--border, #e1e4e8);
    border-radius: 10px;
    border-left: 3px solid transparent;
    text-decoration: none;
    color: inherit;
    transition: box-shadow 0.15s;
  }
  .digest-item:hover {
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  }
  .digest-item.blocking {
    border-left-color: #ef4444;
    background: #fef2f2;
  }
  .digest-item.important {
    border-left-color: #f59e0b;
    background: #fffbeb;
  }
  .digest-item.fyi {
    border-left-color: #94a3b8;
  }
  .digest-item-icon {
    font-size: 18px;
    flex-shrink: 0;
    width: 28px;
    text-align: center;
  }
  .digest-item-content {
    flex: 1;
    min-width: 0;
  }
  .digest-item-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong, #111);
    margin: 0 0 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .digest-item-subtitle {
    font-size: 12px;
    color: var(--text-muted, #777);
    margin: 0;
  }
  .digest-item-priority {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 99px;
    flex-shrink: 0;
  }
  .digest-item-priority.blocking {
    background: #fee2e2;
    color: #b91c1c;
  }
  .digest-item-priority.important {
    background: #fef3c7;
    color: #92400e;
  }
  .digest-item-priority.fyi {
    background: var(--bg, #f1f5f9);
    color: var(--text-muted, #64748b);
  }
  .digest-item-go {
    font-size: 13px;
    color: var(--accent, #0070f3);
    flex-shrink: 0;
    font-weight: 500;
  }

  /* Stats row */
  .digest-stats {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 24px;
  }
  .digest-stat-card {
    flex: 1;
    min-width: 120px;
    padding: 14px 18px;
    background: var(--bg-elevated, #f8f9fa);
    border: 1px solid var(--border, #e1e4e8);
    border-radius: 10px;
    text-align: center;
  }
  .digest-stat-value {
    font-size: 28px;
    font-weight: 800;
    color: var(--text-strong, #111);
    letter-spacing: -0.03em;
    line-height: 1;
    margin-bottom: 4px;
  }
  .digest-stat-label {
    font-size: 12px;
    color: var(--text-muted, #777);
  }

  /* Insight */
  .digest-insight {
    padding: 16px 20px;
    background: linear-gradient(135deg, #f0f4ff 0%, #fdf4ff 100%);
    border: 1px solid #c7d2fe;
    border-radius: 12px;
    margin-bottom: 24px;
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .digest-insight-icon {
    font-size: 20px;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .digest-insight-text {
    font-size: 14px;
    color: #3730a3;
    margin: 0;
    line-height: 1.5;
  }

  /* Empty state */
  .digest-empty {
    text-align: center;
    padding: 48px 24px;
    color: var(--text-muted, #777);
  }
  .digest-empty-icon { font-size: 40px; margin-bottom: 12px; }
  .digest-empty-text { font-size: 16px; font-weight: 600; margin-bottom: 8px; color: var(--text-strong, #111); }
  .digest-empty-sub { font-size: 14px; margin: 0; }

  /* Spinner */
  .digest-spinner-wrap {
    text-align: center;
    padding: 48px 24px;
  }
  .digest-spinner {
    display: inline-block;
    width: 32px;
    height: 32px;
    border: 3px solid var(--border, #e1e4e8);
    border-top-color: var(--accent, #0070f3);
    border-radius: 50%;
    animation: digest-spin 0.8s linear infinite;
    margin-bottom: 12px;
  }
  @keyframes digest-spin { to { transform: rotate(360deg); } }

  /* Section header */
  .digest-section-title {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted, #777);
    margin: 0 0 12px;
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Priority = DigestItem["priority"];
type ItemType = DigestItem["type"];

function priorityLabel(p: Priority): string {
  if (p === "blocking") return "Blocking";
  if (p === "important") return "Important";
  return "FYI";
}

function itemIcon(t: ItemType): string {
  if (t === "pr_review") return "\u{1F50D}";
  if (t === "pr_comment") return "\u{1F4AC}";
  if (t === "ci_failure") return "\u{274C}";
  if (t === "mention") return "\u{1F514}";
  if (t === "dep_update") return "\u{1F4E6}";
  if (t === "new_issue") return "\u{1F41B}";
  return "\u{2022}";
}

// ---------------------------------------------------------------------------
// GET /digest
// ---------------------------------------------------------------------------

digest.get("/digest", softAuth, requireAuth, async (c) => {
  const user = c.get("user")!;
  const generating = c.req.query("generating") === "1";

  // Look up the most recent digest notification
  const [latestDigestNotif] = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, user.id),
        eq(notifications.kind, "digest")
      )
    )
    .orderBy(desc(notifications.createdAt))
    .limit(1)
    .catch(() => []);

  let digestData: SmartDigest | null = null;
  let isToday = false;

  if (latestDigestNotif?.body) {
    try {
      digestData = JSON.parse(latestDigestNotif.body) as SmartDigest;
      const digestDate = new Date(digestData.generatedAt);
      const now = new Date();
      isToday =
        digestDate.getFullYear() === now.getFullYear() &&
        digestDate.getMonth() === now.getMonth() &&
        digestDate.getDate() === now.getDate();
    } catch {
      /* malformed JSON */
    }
  }

  // Auto-generate if no digest today and not already generating
  if (!isToday && !generating) {
    // Fire-and-forget then redirect with ?generating=1 to show spinner
    void (async () => {
      try {
        await sendSmartDigest(user.id);
      } catch {
        /* swallow */
      }
    })();
    return c.redirect("/digest?generating=1");
  }

  // If generating, show spinner page that polls
  if (generating && !isToday) {
    return c.html(
      <Layout title="Morning Digest" user={user}>
        <style dangerouslySetInnerHTML={{ __html: DIGEST_STYLES }} />
        <div style="max-width:720px;margin:0 auto;padding:24px 16px">
          <h1 class="digest-headline" style="margin-bottom:24px">
            Morning Digest
          </h1>
          <div class="digest-spinner-wrap">
            <div class="digest-spinner" />
            <p style="font-size:15px;color:var(--text-muted);margin:0">
              Generating your digest...
            </p>
          </div>
          <script
            dangerouslySetInnerHTML={{
              __html: `
                setTimeout(function() {
                  window.location.href = '/digest';
                }, 3000);
              `,
            }}
          />
        </div>
      </Layout>
    );
  }

  return c.html(
    <Layout title="Morning Digest" user={user}>
      <style dangerouslySetInnerHTML={{ __html: DIGEST_STYLES }} />
      <div style="max-width:720px;margin:0 auto;padding:24px 16px">

        {/* Hero */}
        <div class="digest-hero">
          <span class="digest-hero-icon" aria-hidden="true">{"☀"}</span>
          <h1 class="digest-headline">
            {digestData?.headline || "No digest available"}
          </h1>
          {digestData && (
            <p class="digest-meta">
              Generated {formatRelative(digestData.generatedAt)}
            </p>
          )}
          <div class="digest-actions">
            <form method="post" action="/digest/refresh" style="display:inline">
              <button type="submit" class="digest-regenerate-btn">
                {"↻"} Regenerate
              </button>
            </form>
            <a href="/inbox" class="digest-regenerate-btn">
              View all notifications
            </a>
          </div>
        </div>

        {/* AI Insight */}
        {digestData?.insight && (
          <div>
            <p class="digest-section-title">AI Insight</p>
            <div class="digest-insight">
              <span class="digest-insight-icon" aria-hidden="true">{"✨"}</span>
              <p class="digest-insight-text">{digestData.insight}</p>
            </div>
          </div>
        )}

        {/* Stats row */}
        {digestData?.stats && (
          <div>
            <p class="digest-section-title">This week</p>
            <div class="digest-stats" style="margin-bottom:24px">
              <div class="digest-stat-card">
                <div class="digest-stat-value">{digestData.stats.prsReviewed}</div>
                <div class="digest-stat-label">PRs reviewed</div>
              </div>
              <div class="digest-stat-card">
                <div class="digest-stat-value">{digestData.stats.issuesClosed}</div>
                <div class="digest-stat-label">Issues closed</div>
              </div>
              <div class="digest-stat-card">
                <div class="digest-stat-value">{digestData.stats.commitsThisWeek}</div>
                <div class="digest-stat-label">Commits</div>
              </div>
            </div>
          </div>
        )}

        {/* Queue */}
        {digestData && digestData.queue.length > 0 ? (
          <div>
            <p class="digest-section-title">Action queue</p>
            <div class="digest-queue">
              {digestData.queue.map((item, idx) => (
                <a
                  key={idx}
                  href={item.url}
                  class={`digest-item ${item.priority}`}
                >
                  <span class="digest-item-icon" aria-hidden="true">
                    {itemIcon(item.type)}
                  </span>
                  <div class="digest-item-content">
                    <p class="digest-item-title">{item.title}</p>
                    <p class="digest-item-subtitle">{item.subtitle}</p>
                  </div>
                  <span class={`digest-item-priority ${item.priority}`}>
                    {priorityLabel(item.priority)}
                  </span>
                  <span class="digest-item-go" aria-hidden="true">{"→"}</span>
                </a>
              ))}
            </div>
          </div>
        ) : digestData ? (
          <div class="digest-empty">
            <div class="digest-empty-icon" aria-hidden="true">{"🎉"}</div>
            <p class="digest-empty-text">All caught up!</p>
            <p class="digest-empty-sub">No action items for today.</p>
          </div>
        ) : (
          <div class="digest-empty">
            <div class="digest-empty-icon" aria-hidden="true">{"📋"}</div>
            <p class="digest-empty-text">No digest yet</p>
            <p class="digest-empty-sub">
              Use the Regenerate button above to create your first digest.
            </p>
          </div>
        )}

      </div>
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// POST /digest/refresh
// ---------------------------------------------------------------------------

digest.post("/digest/refresh", softAuth, requireAuth, async (c) => {
  const user = c.get("user")!;
  // Force a fresh digest by clearing cooldown temporarily — just compose + insert
  try {
    const freshDigest = await composeSmartDigest(user.id);
    if (freshDigest) {
      await db.insert(notifications).values({
        userId: user.id,
        kind: "digest",
        title: freshDigest.headline,
        body: JSON.stringify(freshDigest),
        url: "/digest",
      });
      // Update last sent timestamp
      await db
        .update(users)
        .set({ lastSmartDigestSentAt: new Date() })
        .where(eq(users.id, user.id));
    }
  } catch (err) {
    console.error("[digest] refresh error:", err);
  }
  return c.redirect("/digest");
});

export default digest;
