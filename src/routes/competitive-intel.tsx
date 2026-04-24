/**
 * Competitive Intelligence Engine — Admin UI.
 *
 *   GET  /admin/intelligence                    — dashboard (latest report per competitor)
 *   POST /admin/intelligence/scan               — trigger a new scan (fire-and-forget)
 *   GET  /admin/intelligence/:competitor        — history for one competitor
 *
 * All routes gated by `isSiteAdmin`.
 */

import { Hono } from "hono";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { Layout } from "../views/layout";
import {
  runIntelligenceScan,
  getLatestReports,
  getReportHistory,
  getLastScanRun,
  COMPETITORS,
  type CompetitorReport,
  type GapIdentified,
  type FeatureShipped,
} from "../lib/competitive-intel";

const competitiveIntel = new Hono<AuthEnv>();
competitiveIntel.use("*", softAuth);

// ---------------------------------------------------------------------------
// Auth gate helper (mirrors admin.tsx pattern)
// ---------------------------------------------------------------------------

async function gate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/intelligence");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="empty-state">
          <h2>403 — Not a site admin</h2>
          <p>You don't have permission to view this page.</p>
        </div>
      </Layout>,
      403
    );
  }
  return { user };
}

// ---------------------------------------------------------------------------
// Priority badge helper
// ---------------------------------------------------------------------------

function PriorityBadge({ priority }: { priority: "high" | "medium" | "low" }) {
  const styles: Record<string, string> = {
    high: "background:#f85149;color:#fff",
    medium: "background:#d29922;color:#0d1117",
    low: "background:#30363d;color:#8b949e",
  };
  return (
    <span
      style={`display:inline-block;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;text-transform:uppercase;${styles[priority] ?? styles.low}`}
    >
      {priority}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Competitor display name helper
// ---------------------------------------------------------------------------

function competitorName(id: string): string {
  const c = COMPETITORS.find((c) => c.id === id);
  return c ? c.name : id;
}

// ---------------------------------------------------------------------------
// Format a date string nicely
// ---------------------------------------------------------------------------

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  try {
    return new Date(d as string).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return String(d);
  }
}

// ---------------------------------------------------------------------------
// Compute gap priority counts across all reports
// ---------------------------------------------------------------------------

function countGapsByPriority(reports: CompetitorReport[]) {
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const r of reports) {
    const gaps = (r.gapsIdentified ?? []) as GapIdentified[];
    for (const g of gaps) {
      if (g.priority === "high") high++;
      else if (g.priority === "medium") medium++;
      else low++;
    }
  }
  return { high, medium, low };
}

// ---------------------------------------------------------------------------
// GET /admin/intelligence — dashboard
// ---------------------------------------------------------------------------

competitiveIntel.get("/admin/intelligence", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const [reports, lastRun] = await Promise.all([
    getLatestReports(),
    getLastScanRun(),
  ]);

  const scanStarted = c.req.query("scan") === "started";
  const gapCounts = countGapsByPriority(reports);

  // Map reports by competitor id for easy lookup
  const reportMap = new Map<string, CompetitorReport>(
    reports.map((r) => [r.competitor, r])
  );

  return c.html(
    <Layout title="Competitive Intelligence — Admin" user={user}>
      <div style="max-width:1100px;margin:0 auto;padding:24px 16px">
        {/* Header */}
        <div
          style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:8px"
        >
          <div>
            <h1 style="margin:0;font-size:22px;font-weight:700">
              Competitive Intelligence
            </h1>
            <p style="color:var(--text-muted);font-size:13px;margin-top:4px">
              Weekly gap analysis — what competitors are shipping vs. what
              Gluecron has.
            </p>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <a href="/admin" class="btn btn-sm">
              Back to Admin
            </a>
            <form method="post" action="/admin/intelligence/scan">
              <button
                type="submit"
                class="btn btn-primary btn-sm"
                onclick="this.disabled=true;this.textContent='Scanning…';this.form.submit()"
              >
                Run scan now
              </button>
            </form>
          </div>
        </div>

        {/* Scan started banner */}
        {scanStarted && (
          <div
            class="auth-success"
            style="margin-bottom:16px;font-size:13px"
          >
            Scan started in the background. Refresh in a few minutes to see
            updated reports.
          </div>
        )}

        {/* Last scan status */}
        {lastRun && (
          <div
            style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:10px 16px;margin-bottom:20px;font-size:13px;display:flex;gap:16px;flex-wrap:wrap;align-items:center"
          >
            <span>
              <span style="color:var(--text-muted)">Last scan:</span>{" "}
              {fmtDate(lastRun.startedAt as unknown as string)}
            </span>
            <span>
              <span style="color:var(--text-muted)">Status:</span>{" "}
              <span
                style={
                  lastRun.status === "completed"
                    ? "color:var(--green);font-weight:600"
                    : lastRun.status === "failed"
                    ? "color:var(--red);font-weight:600"
                    : "color:var(--yellow);font-weight:600"
                }
              >
                {lastRun.status}
              </span>
            </span>
            <span>
              <span style="color:var(--text-muted)">Reports created:</span>{" "}
              {lastRun.competitorsScanned}
            </span>
            {lastRun.error && (
              <span style="color:var(--red);font-size:12px">
                {lastRun.error}
              </span>
            )}
          </div>
        )}

        {/* Gap summary counts */}
        <div
          style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px"
        >
          <div
            style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:14px;text-align:center"
          >
            <div style="font-size:26px;font-weight:700;color:var(--red)">
              {gapCounts.high}
            </div>
            <div
              style="font-size:11px;text-transform:uppercase;color:var(--text-muted);margin-top:2px"
            >
              High-priority gaps
            </div>
          </div>
          <div
            style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:14px;text-align:center"
          >
            <div style="font-size:26px;font-weight:700;color:var(--yellow)">
              {gapCounts.medium}
            </div>
            <div
              style="font-size:11px;text-transform:uppercase;color:var(--text-muted);margin-top:2px"
            >
              Medium-priority gaps
            </div>
          </div>
          <div
            style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:14px;text-align:center"
          >
            <div style="font-size:26px;font-weight:700;color:var(--text-muted)">
              {gapCounts.low}
            </div>
            <div
              style="font-size:11px;text-transform:uppercase;color:var(--text-muted);margin-top:2px"
            >
              Low-priority gaps
            </div>
          </div>
          <div
            style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:14px;text-align:center"
          >
            <div style="font-size:26px;font-weight:700">
              {reports.length}
            </div>
            <div
              style="font-size:11px;text-transform:uppercase;color:var(--text-muted);margin-top:2px"
            >
              Competitors tracked
            </div>
          </div>
        </div>

        {/* Competitor cards grid */}
        {reports.length === 0 ? (
          <div
            style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:48px;text-align:center;color:var(--text-muted)"
          >
            <p style="font-size:15px;margin-bottom:8px">No reports yet.</p>
            <p style="font-size:13px">
              Click "Run scan now" to fetch the latest competitor changelogs and
              analyse gaps with Claude.
            </p>
          </div>
        ) : (
          <div
            style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px"
          >
            {COMPETITORS.map((comp) => {
              const report = reportMap.get(comp.id);
              return (
                <div
                  style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;display:flex;flex-direction:column"
                >
                  {/* Card header */}
                  <div
                    style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center"
                  >
                    <div>
                      <span style="font-weight:700;font-size:15px">
                        {comp.name}
                      </span>
                      {report && (
                        <span
                          style="margin-left:8px;font-size:12px;color:var(--text-muted)"
                        >
                          {fmtDate(report.reportDate as unknown as string)}
                        </span>
                      )}
                    </div>
                    <a
                      href={`/admin/intelligence/${comp.id}`}
                      style="font-size:12px;color:var(--text-link)"
                    >
                      History
                    </a>
                  </div>

                  {/* Card body */}
                  <div style="padding:14px 16px;flex:1;display:flex;flex-direction:column;gap:12px">
                    {!report ? (
                      <p style="font-size:13px;color:var(--text-muted)">
                        No report available. Run a scan to populate.
                      </p>
                    ) : (
                      <>
                        {/* Summary */}
                        {report.summary && (
                          <p style="font-size:13px;color:var(--text-muted);line-height:1.55">
                            {report.summary}
                          </p>
                        )}

                        {/* Gaps — high priority first */}
                        {(report.gapsIdentified as GapIdentified[]).length >
                          0 && (
                          <div>
                            <div
                              style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px;letter-spacing:0.05em"
                            >
                              Gaps identified (
                              {
                                (report.gapsIdentified as GapIdentified[])
                                  .length
                              }
                              )
                            </div>
                            <ul
                              style="list-style:none;display:flex;flex-direction:column;gap:6px"
                            >
                              {(report.gapsIdentified as GapIdentified[])
                                .sort((a, b) => {
                                  const order = {
                                    high: 0,
                                    medium: 1,
                                    low: 2,
                                  };
                                  return (
                                    (order[a.priority] ?? 3) -
                                    (order[b.priority] ?? 3)
                                  );
                                })
                                .slice(0, 5)
                                .map((gap) => (
                                  <li
                                    style="display:flex;align-items:flex-start;gap:8px;font-size:13px"
                                  >
                                    <PriorityBadge priority={gap.priority} />
                                    <span style="color:var(--text)">
                                      {gap.feature}
                                    </span>
                                  </li>
                                ))}
                              {(report.gapsIdentified as GapIdentified[])
                                .length > 5 && (
                                <li
                                  style="font-size:12px;color:var(--text-muted)"
                                >
                                  +
                                  {(report.gapsIdentified as GapIdentified[])
                                    .length - 5}{" "}
                                  more —{" "}
                                  <a
                                    href={`/admin/intelligence/${comp.id}`}
                                    style="color:var(--text-link)"
                                  >
                                    see all
                                  </a>
                                </li>
                              )}
                            </ul>
                          </div>
                        )}

                        {/* Features shipped */}
                        {(report.featuresShipped as FeatureShipped[]).length >
                          0 && (
                          <div>
                            <div
                              style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px;letter-spacing:0.05em"
                            >
                              Features shipped (
                              {
                                (report.featuresShipped as FeatureShipped[])
                                  .length
                              }
                              )
                            </div>
                            <ul
                              style="list-style:none;display:flex;flex-direction:column;gap:4px"
                            >
                              {(report.featuresShipped as FeatureShipped[])
                                .slice(0, 4)
                                .map((f) => (
                                  <li style="font-size:13px;color:var(--text-muted)">
                                    {f.url ? (
                                      <a
                                        href={f.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style="color:var(--text-link)"
                                      >
                                        {f.title}
                                      </a>
                                    ) : (
                                      <span style="color:var(--text)">
                                        {f.title}
                                      </span>
                                    )}
                                  </li>
                                ))}
                              {(report.featuresShipped as FeatureShipped[])
                                .length > 4 && (
                                <li
                                  style="font-size:12px;color:var(--text-muted)"
                                >
                                  +
                                  {(report.featuresShipped as FeatureShipped[])
                                    .length - 4}{" "}
                                  more
                                </li>
                              )}
                            </ul>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {/* Card footer */}
                  <div
                    style="padding:10px 16px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center"
                  >
                    <a
                      href={comp.changelogUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style="font-size:12px;color:var(--text-muted)"
                    >
                      Changelog ↗
                    </a>
                    <a
                      href={`/admin/intelligence/${comp.id}`}
                      class="btn btn-sm"
                      style="font-size:12px"
                    >
                      View history
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// POST /admin/intelligence/scan — trigger scan (fire-and-forget)
// ---------------------------------------------------------------------------

competitiveIntel.post("/admin/intelligence/scan", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;

  // Fire-and-forget — do NOT await
  runIntelligenceScan().catch((err) => {
    console.error("[competitive-intel] background scan error:", err);
  });

  return c.redirect("/admin/intelligence?scan=started");
});

// ---------------------------------------------------------------------------
// GET /admin/intelligence/:competitor — history for one competitor
// ---------------------------------------------------------------------------

competitiveIntel.get("/admin/intelligence/:competitor", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const competitorId = c.req.param("competitor");
  const knownCompetitor = COMPETITORS.find((x) => x.id === competitorId);

  if (!knownCompetitor) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>404</h2>
          <p>Competitor not found: {competitorId}</p>
          <a href="/admin/intelligence" style="margin-top:12px;display:inline-block">
            Back to Intelligence
          </a>
        </div>
      </Layout>,
      404
    );
  }

  const history = await getReportHistory(competitorId, 20);
  const name = knownCompetitor.name;

  return c.html(
    <Layout title={`${name} — Intelligence History`} user={user}>
      <div style="max-width:960px;margin:0 auto;padding:24px 16px">
        {/* Header */}
        <div
          style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:20px"
        >
          <div>
            <h1 style="font-size:22px;font-weight:700;margin:0">
              {name} — Intelligence History
            </h1>
            <p style="color:var(--text-muted);font-size:13px;margin-top:4px">
              {history.length} report{history.length === 1 ? "" : "s"} on
              record.{" "}
              <a
                href={knownCompetitor.changelogUrl}
                target="_blank"
                rel="noopener noreferrer"
                style="color:var(--text-link)"
              >
                View live changelog ↗
              </a>
            </p>
          </div>
          <a href="/admin/intelligence" class="btn btn-sm">
            Back to Dashboard
          </a>
        </div>

        {/* Timeline */}
        {history.length === 0 ? (
          <div
            style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:48px;text-align:center;color:var(--text-muted)"
          >
            <p>No reports for {name} yet. Run a scan to generate one.</p>
          </div>
        ) : (
          <div style="display:flex;flex-direction:column;gap:20px">
            {history.map((report, idx) => {
              const gaps = (report.gapsIdentified ?? []) as GapIdentified[];
              const features = (
                report.featuresShipped ?? []
              ) as FeatureShipped[];
              const highGaps = gaps.filter((g) => g.priority === "high");
              const medGaps = gaps.filter((g) => g.priority === "medium");
              const lowGaps = gaps.filter((g) => g.priority === "low");

              return (
                <div
                  style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden"
                >
                  {/* Report header */}
                  <div
                    style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px"
                  >
                    <div style="display:flex;align-items:center;gap:12px">
                      <span
                        style="background:var(--accent);color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:3px"
                      >
                        {idx === 0 ? "LATEST" : `#${idx + 1}`}
                      </span>
                      <span style="font-weight:600;font-size:15px">
                        Week of{" "}
                        {fmtDate(report.reportDate as unknown as string)}
                      </span>
                    </div>
                    <div
                      style="display:flex;gap:8px;font-size:12px;color:var(--text-muted)"
                    >
                      <span>
                        <span style="color:var(--red);font-weight:600">
                          {highGaps.length}
                        </span>{" "}
                        high
                      </span>
                      <span>
                        <span style="color:var(--yellow);font-weight:600">
                          {medGaps.length}
                        </span>{" "}
                        medium
                      </span>
                      <span>
                        <span style="color:var(--text-muted);font-weight:600">
                          {lowGaps.length}
                        </span>{" "}
                        low
                      </span>
                      <span>{features.length} features shipped</span>
                    </div>
                  </div>

                  {/* Report body */}
                  <div
                    style="padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:20px"
                  >
                    {/* Left: summary + gaps */}
                    <div>
                      {report.summary && (
                        <div style="margin-bottom:14px">
                          <div
                            style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px;letter-spacing:0.05em"
                          >
                            Summary
                          </div>
                          <p
                            style="font-size:13px;color:var(--text-muted);line-height:1.6"
                          >
                            {report.summary}
                          </p>
                        </div>
                      )}

                      {gaps.length > 0 && (
                        <div>
                          <div
                            style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;letter-spacing:0.05em"
                          >
                            Gaps identified ({gaps.length})
                          </div>
                          <ul
                            style="list-style:none;display:flex;flex-direction:column;gap:8px"
                          >
                            {[...highGaps, ...medGaps, ...lowGaps].map(
                              (gap) => (
                                <li style="font-size:13px">
                                  <div
                                    style="display:flex;align-items:flex-start;gap:8px;margin-bottom:2px"
                                  >
                                    <PriorityBadge priority={gap.priority} />
                                    <span
                                      style="color:var(--text);font-weight:500"
                                    >
                                      {gap.feature}
                                    </span>
                                  </div>
                                  {gap.notes && (
                                    <p
                                      style="font-size:12px;color:var(--text-muted);margin-top:3px;padding-left:4px;line-height:1.5"
                                    >
                                      {gap.notes}
                                    </p>
                                  )}
                                </li>
                              )
                            )}
                          </ul>
                        </div>
                      )}
                    </div>

                    {/* Right: features shipped */}
                    <div>
                      {features.length > 0 && (
                        <div>
                          <div
                            style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;letter-spacing:0.05em"
                          >
                            Features shipped ({features.length})
                          </div>
                          <ul
                            style="list-style:none;display:flex;flex-direction:column;gap:10px"
                          >
                            {features.map((f) => (
                              <li style="font-size:13px">
                                <div style="font-weight:500;color:var(--text);margin-bottom:2px">
                                  {f.url ? (
                                    <a
                                      href={f.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style="color:var(--text-link)"
                                    >
                                      {f.title}
                                    </a>
                                  ) : (
                                    f.title
                                  )}
                                </div>
                                {f.description && (
                                  <p
                                    style="font-size:12px;color:var(--text-muted);line-height:1.5"
                                  >
                                    {f.description}
                                  </p>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {features.length === 0 && gaps.length === 0 && (
                        <p style="font-size:13px;color:var(--text-muted)">
                          No structured data extracted for this report.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Mobile: single-column layout for the report body grid */}
      <style>{`
        @media (max-width: 640px) {
          .intel-report-body {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </Layout>
  );
});

export default competitiveIntel;
