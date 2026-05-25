/**
 * `/activity` — the user's personal timeline.
 *
 * One reverse-chronological feed of everything that touched the user's
 * repos or was authored by them. The differentiator vs. github.com/
 * <user> is the first-class AI lane: when Claude reviews a PR, triages
 * an issue, or auto-merges, those events get pulled out of the noise
 * with an AI-EVENT badge and a dedicated tab.
 *
 * Filters:
 *   - all     — everything we have
 *   - ai      — only `ai:*` actions (the differentiator)
 *   - code    — push / merge / branch / commit events
 *   - social  — stars / follows / forks
 *
 * Pagination: `?before=<ISO-timestamp>` walks back in pages of 100.
 *
 * Scoped CSS under `.act-*`.
 */

import { Hono } from "hono";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { db } from "../db";
import { activityFeed, repositories } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const activity = new Hono<AuthEnv>();
activity.use("*", softAuth);

const styles = `
  .act-wrap { max-width: 1100px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .act-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .act-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .act-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
  }
  .act-hero-inner { position: relative; z-index: 1; max-width: 780px; }
  .act-eyebrow {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-bottom: 8px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .act-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 10px;
    color: var(--text-strong);
  }
  .act-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .act-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  .act-stats {
    display: flex;
    gap: 24px;
    margin-top: 16px;
    flex-wrap: wrap;
    align-items: flex-end;
  }
  .act-stat { display: flex; flex-direction: column; gap: 2px; }
  .act-stat-n {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
  }
  .act-stat-l {
    font-size: 11.5px;
    color: var(--text-muted);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .act-stat.ai .act-stat-n {
    background-image: linear-gradient(135deg, #b69dff 0%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }

  .act-spark {
    display: inline-flex;
    align-items: flex-end;
    gap: 3px;
    height: 28px;
    margin-left: auto;
    padding: 4px 8px;
    border-radius: 6px;
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
  }
  .act-spark-bar {
    width: 6px;
    background: linear-gradient(180deg, #8c6dff 0%, #36c5d6 100%);
    border-radius: 1px 1px 0 0;
    opacity: 0.85;
    min-height: 2px;
  }
  .act-spark-label {
    font-size: 11px;
    color: var(--text-muted);
    margin-left: 8px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .act-tabs {
    display: inline-flex;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    padding: 4px;
    gap: 2px;
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }
  .act-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 500;
    color: var(--text-muted);
    text-decoration: none;
    transition: color 120ms ease, background 120ms ease;
  }
  .act-tab:hover { color: var(--text-strong); text-decoration: none; }
  .act-tab.is-active {
    background: rgba(140,109,255,0.14);
    color: var(--text-strong);
  }
  .act-tab-count {
    font-variant-numeric: tabular-nums;
    font-size: 11.5px;
    background: rgba(255,255,255,0.04);
    padding: 1px 7px;
    border-radius: 9999px;
  }
  .act-tab.is-active .act-tab-count {
    background: rgba(140,109,255,0.22);
    color: var(--text);
  }

  .act-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .act-row {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    transition: background 120ms ease;
    text-decoration: none;
    color: inherit;
  }
  .act-row:last-child { border-bottom: none; }
  .act-row:hover { background: rgba(140,109,255,0.04); text-decoration: none; }
  .act-row.is-ai {
    background: linear-gradient(90deg, rgba(140,109,255,0.05) 0%, transparent 60%);
  }
  .act-row.is-ai:hover {
    background: linear-gradient(90deg, rgba(140,109,255,0.10) 0%, rgba(140,109,255,0.03) 60%);
  }

  .act-row-icon {
    width: 28px; height: 28px;
    flex-shrink: 0;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .act-row-icon.kind-ai     { background: rgba(140,109,255,0.18); color: #b69dff; box-shadow: inset 0 0 0 1px rgba(140,109,255,0.40); }
  .act-row-icon.kind-code   { background: rgba(54,197,214,0.14); color: #6fd6e6; box-shadow: inset 0 0 0 1px rgba(54,197,214,0.32); }
  .act-row-icon.kind-pr     { background: rgba(52,211,153,0.13); color: #6ee7b7; box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30); }
  .act-row-icon.kind-issue  { background: rgba(251,191,36,0.12); color: #fde68a; box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30); }
  .act-row-icon.kind-social { background: rgba(244,114,182,0.12); color: #f9a8d4; box-shadow: inset 0 0 0 1px rgba(244,114,182,0.30); }
  .act-row-icon.kind-merge  { background: rgba(140,109,255,0.16); color: #b69dff; box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32); }

  .act-row-main { flex: 1; min-width: 0; }
  .act-row-title {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.35;
    letter-spacing: -0.012em;
    margin: 0 0 4px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    color: var(--text-strong);
  }
  .act-verb {
    text-transform: lowercase;
    font-weight: 600;
  }
  .act-verb.kind-ai     { color: #b69dff; }
  .act-verb.kind-code   { color: #6fd6e6; }
  .act-verb.kind-pr     { color: #6ee7b7; }
  .act-verb.kind-issue  { color: #fde68a; }
  .act-verb.kind-social { color: #f9a8d4; }
  .act-verb.kind-merge  { color: #b69dff; }

  .act-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    font-size: 10.5px;
    font-weight: 700;
    border-radius: 9999px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
  }
  .act-badge.ai-event {
    color: #b69dff;
    background: rgba(140,109,255,0.18);
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.40);
  }
  .act-badge.ai-event .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
    box-shadow: 0 0 8px currentColor;
  }

  .act-row-meta {
    font-size: 12.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
  }
  .act-row-meta .sep { opacity: 0.45; }
  .act-row-repo {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
  }
  .act-row-time {
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }

  .act-pager {
    display: flex;
    justify-content: center;
    margin-top: var(--space-4);
  }

  .act-empty {
    padding: 60px 20px;
    text-align: center;
    border: 1px dashed var(--border-strong);
    border-radius: 14px;
    background: var(--bg-elevated);
    position: relative;
    overflow: hidden;
  }
  .act-empty::before {
    content: '';
    position: absolute;
    inset: -20% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.10), transparent 70%);
    filter: blur(60px);
    pointer-events: none;
  }
  .act-empty-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
    position: relative;
  }
  .act-empty-sub {
    color: var(--text-muted);
    font-size: 14px;
    margin: 0 0 18px;
    position: relative;
  }
  .act-empty .btn { position: relative; }

  @media (max-width: 720px) {
    .act-hero { padding: 24px 20px; }
    .act-row { padding: 12px 14px; }
    .act-stats { gap: 16px; }
    .act-spark { margin-left: 0; }
  }
`;

type ActFilter = "all" | "ai" | "code" | "social";
const VALID_FILTERS: ActFilter[] = ["all", "ai", "code", "social"];

type ActKind = "ai" | "code" | "pr" | "issue" | "social" | "merge" | "other";

interface Classified {
  kind: ActKind;
  isAi: boolean;
  verb: string;
  category: "ai" | "code" | "social" | "other";
}

/**
 * Map a raw `action` string to a kind + display verb + filter category.
 * The schema doesn't enforce a controlled vocabulary so we pattern-match
 * defensively. `ai:` prefix wins regardless of the underlying action.
 */
function classify(action: string): Classified {
  const a = (action || "").toLowerCase();
  const isAi = a.startsWith("ai:") || a.includes(":ai") || a.includes(".ai.");
  // The verb shown to the user — strip prefixes / normalise separators.
  const verb = a.replace(/^ai:/, "").replace(/[._]/g, "-");

  if (isAi) {
    return { kind: "ai", isAi: true, verb, category: "ai" };
  }
  if (
    a.includes("push") ||
    a.includes("commit") ||
    a.includes("branch") ||
    a.includes("tag") ||
    a.includes("merge") ||
    a.includes("deploy")
  ) {
    const kind: ActKind = a.includes("merge") ? "merge" : "code";
    return { kind, isAi: false, verb, category: "code" };
  }
  if (a.includes("pr") || a.includes("pull")) {
    return { kind: "pr", isAi: false, verb, category: "code" };
  }
  if (a.includes("issue")) {
    return { kind: "issue", isAi: false, verb, category: "other" };
  }
  if (
    a.includes("star") ||
    a.includes("fork") ||
    a.includes("follow") ||
    a.includes("watch")
  ) {
    return { kind: "social", isAi: false, verb, category: "social" };
  }
  return { kind: "other", isAi: false, verb, category: "other" };
}

function iconLabel(kind: ActKind): string {
  switch (kind) {
    case "ai":
      return "AI";
    case "code":
      return "</>";
    case "pr":
      return "PR";
    case "issue":
      return "!";
    case "social":
      return "★";
    case "merge":
      return "M";
    default:
      return "·";
  }
}

function relTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * Best-effort source URL for a row. Falls back to the repo page when the
 * target type/id isn't enough to deep-link.
 */
function sourceHref(
  ownerUsername: string,
  repoName: string,
  targetType: string | null,
  targetId: string | null
): string {
  const base = `/${ownerUsername}/${repoName}`;
  if (!targetId) return base;
  switch (targetType) {
    case "issue":
      return `${base}/issues/${targetId}`;
    case "pr":
    case "pull_request":
      return `${base}/pulls/${targetId}`;
    case "commit":
      return `${base}/commit/${targetId}`;
    default:
      return base;
  }
}

activity.get("/activity", requireAuth, async (c) => {
  const user = c.get("user")!;
  const rawFilter = c.req.query("filter") || "all";
  const filter: ActFilter = (VALID_FILTERS as string[]).includes(rawFilter)
    ? (rawFilter as ActFilter)
    : "all";

  const beforeRaw = c.req.query("before");
  let before: Date | null = null;
  if (beforeRaw) {
    const t = Date.parse(beforeRaw);
    if (!Number.isNaN(t)) before = new Date(t);
  }

  // Build the candidate set: anything authored by the user OR scoped to
  // a repo the user owns. Collaborator repos aren't pulled in here — the
  // dashboard does that and it'd blow the timeline up with noise.
  let ownedRepoIds: string[] = [];
  try {
    const owned = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.ownerId, user.id));
    ownedRepoIds = owned.map((r) => r.id);
  } catch (err) {
    console.error("[activity] owned repo lookup failed:", err);
  }

  type Row = typeof activityFeed.$inferSelect;
  let rows: Row[] = [];
  try {
    const scopeClause =
      ownedRepoIds.length > 0
        ? or(
            eq(activityFeed.userId, user.id),
            inArray(activityFeed.repositoryId, ownedRepoIds)
          )!
        : eq(activityFeed.userId, user.id);
    const whereClause = before
      ? and(scopeClause, lt(activityFeed.createdAt, before))!
      : scopeClause;
    rows = await db
      .select()
      .from(activityFeed)
      .where(whereClause)
      .orderBy(desc(activityFeed.createdAt))
      .limit(100);
  } catch (err) {
    console.error("[activity] feed query failed:", err);
  }

  // Resolve repo names / owner usernames in one batched lookup so each
  // row card can render the `owner/repo` mono pill + a deep link.
  const repoIds = Array.from(new Set(rows.map((r) => r.repositoryId)));
  const repoInfo = new Map<
    string,
    { name: string; ownerUsername: string }
  >();
  if (repoIds.length > 0) {
    try {
      const { users } = await import("../db/schema");
      const repoRows = await db
        .select({
          id: repositories.id,
          name: repositories.name,
          ownerUsername: users.username,
        })
        .from(repositories)
        .innerJoin(users, eq(users.id, repositories.ownerId))
        .where(inArray(repositories.id, repoIds));
      for (const r of repoRows) {
        repoInfo.set(r.id, {
          name: r.name,
          ownerUsername: r.ownerUsername,
        });
      }
    } catch (err) {
      console.error("[activity] repo info lookup failed:", err);
    }
  }

  // Classify once, then partition for tab counters + the active filter.
  const classified = rows.map((r) => ({ row: r, info: classify(r.action) }));
  const counts = {
    all: classified.length,
    ai: classified.filter((x) => x.info.category === "ai").length,
    code: classified.filter((x) => x.info.category === "code").length,
    social: classified.filter((x) => x.info.category === "social").length,
  };

  const visible = classified.filter((x) => {
    if (filter === "all") return true;
    return x.info.category === filter;
  });

  // "This week" mini sparkline — 7 buckets, 24h each, ending now. Cheap
  // (operates on the already-fetched 100 rows; no extra query).
  const weekBuckets = new Array<number>(7).fill(0);
  const now = Date.now();
  for (const x of classified) {
    const ageMs = now - x.row.createdAt.getTime();
    const day = Math.floor(ageMs / (24 * 3600 * 1000));
    if (day >= 0 && day < 7) {
      // Bucket 0 = oldest day in the week, 6 = today.
      weekBuckets[6 - day] = (weekBuckets[6 - day] ?? 0) + 1;
    }
  }
  const weekMax = Math.max(1, ...weekBuckets);
  const weekTotal = weekBuckets.reduce((a, b) => a + b, 0);

  const oldestVisible =
    visible.length === 100 ? visible[visible.length - 1]!.row.createdAt : null;
  const nextHref = oldestVisible
    ? `/activity?filter=${filter}&before=${encodeURIComponent(
        oldestVisible.toISOString()
      )}`
    : null;

  const emptyCopy =
    filter === "ai"
      ? {
          title: "No AI events yet.",
          sub: "When Claude reviews a PR, triages an issue, or auto-merges in one of your repos, it'll land here with an AI-EVENT badge.",
        }
      : filter === "code"
        ? {
            title: "No code events yet.",
            sub: "Pushes, merges, branches, and tags from your repos will appear here in real time.",
          }
        : filter === "social"
          ? {
              title: "No social activity yet.",
              sub: "Stars, follows, and forks across your repos will surface here.",
            }
          : {
              title: "Your timeline is quiet.",
              sub: "Push a branch, open a PR, or star a repo — everything Gluecron sees lands here, ordered newest first.",
            };

  return c.html(
    <Layout title="Activity · Gluecron" user={user}>
      <div class="act-wrap">
        <section class="act-hero">
          <div class="act-orb" aria-hidden="true" />
          <div class="act-hero-inner">
            <div class="act-eyebrow">
              Personal timeline · live ·{" "}
              <span style="color:var(--accent);font-weight:600">
                {user.username}
              </span>
            </div>
            <h1 class="act-title">
              <span class="act-title-grad">Your activity.</span>
            </h1>
            <p class="act-sub">
              Everything that's happened across your repos — pushes, PRs,
              issues, stars — plus the things Claude did on your behalf.
              AI events surface separately so you always see the work that
              shipped while you were away.
            </p>
            <div class="act-stats">
              <div class="act-stat">
                <div class="act-stat-n">{counts.all}</div>
                <div class="act-stat-l">Total</div>
              </div>
              <div class="act-stat ai">
                <div class="act-stat-n">{counts.ai}</div>
                <div class="act-stat-l">AI events</div>
              </div>
              <div class="act-stat">
                <div class="act-stat-n">{counts.code}</div>
                <div class="act-stat-l">Code</div>
              </div>
              <div class="act-stat">
                <div class="act-stat-n">{counts.social}</div>
                <div class="act-stat-l">Social</div>
              </div>
              {weekTotal > 0 && (
                <div class="act-spark" aria-label="Events per day, last 7 days">
                  {weekBuckets.map((n) => (
                    <div
                      class="act-spark-bar"
                      style={`height: ${Math.max(2, Math.round((n / weekMax) * 24))}px`}
                      title={`${n} event${n === 1 ? "" : "s"}`}
                    />
                  ))}
                  <span class="act-spark-label">7d · {weekTotal}</span>
                </div>
              )}
            </div>
          </div>
        </section>

        <nav class="act-tabs" aria-label="Activity filters">
          <a
            href="/activity?filter=all"
            class={"act-tab " + (filter === "all" ? "is-active" : "")}
          >
            All <span class="act-tab-count">{counts.all}</span>
          </a>
          <a
            href="/activity?filter=ai"
            class={"act-tab " + (filter === "ai" ? "is-active" : "")}
          >
            AI <span class="act-tab-count">{counts.ai}</span>
          </a>
          <a
            href="/activity?filter=code"
            class={"act-tab " + (filter === "code" ? "is-active" : "")}
          >
            Code <span class="act-tab-count">{counts.code}</span>
          </a>
          <a
            href="/activity?filter=social"
            class={"act-tab " + (filter === "social" ? "is-active" : "")}
          >
            Social <span class="act-tab-count">{counts.social}</span>
          </a>
        </nav>

        {visible.length === 0 ? (
          <div class="act-empty">
            <h2 class="act-empty-title">{emptyCopy.title}</h2>
            <p class="act-empty-sub">{emptyCopy.sub}</p>
            <a href="/explore" class="btn btn-primary">
              Explore repos
            </a>
          </div>
        ) : (
          <>
            <ul class="act-list">
              {visible.map((x) => {
                const info = repoInfo.get(x.row.repositoryId);
                const repoName = info?.name || "unknown";
                const ownerUsername = info?.ownerUsername || "unknown";
                const href = sourceHref(
                  ownerUsername,
                  repoName,
                  x.row.targetType,
                  x.row.targetId
                );
                const kindClass = `kind-${x.info.kind}`;
                return (
                  <li>
                    <a
                      href={href}
                      class={"act-row " + (x.info.isAi ? "is-ai" : "")}
                    >
                      <span
                        class={"act-row-icon " + kindClass}
                        aria-hidden="true"
                      >
                        {iconLabel(x.info.kind)}
                      </span>
                      <div class="act-row-main">
                        <h3 class="act-row-title">
                          <span class={"act-verb " + kindClass}>
                            {x.info.verb || "event"}
                          </span>
                          {x.info.isAi && (
                            <span
                              class="act-badge ai-event"
                              title="Claude did this for you"
                            >
                              <span class="dot" aria-hidden="true" /> AI-EVENT
                            </span>
                          )}
                        </h3>
                        <div class="act-row-meta">
                          <span class="act-row-repo">
                            {ownerUsername}/{repoName}
                          </span>
                          <span class="sep">·</span>
                          <span class="act-row-time">
                            {relTime(x.row.createdAt)}
                          </span>
                        </div>
                      </div>
                    </a>
                  </li>
                );
              })}
            </ul>
            {nextHref && (
              <div class="act-pager">
                <a href={nextHref} class="btn">
                  Older
                </a>
              </div>
            )}
          </>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </Layout>
  );
});

export default activity;
