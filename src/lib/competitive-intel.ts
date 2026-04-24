/**
 * Competitive Intelligence Engine.
 *
 * Monitors GitHub, GitLab, Bitbucket, Linear, Vercel, and Render changelogs
 * weekly, uses Claude to analyse what they've shipped, and surfaces a
 * "what are we missing?" gap report for the admin team.
 *
 * Key exports:
 *   runIntelligenceScan()   — main orchestrator (call from admin UI / cron)
 *   getLatestReports()      — one report per competitor, most recent
 *   getReportHistory()      — historical reports for a single competitor
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { eq, desc, sql, and } from "drizzle-orm";
import { db } from "../db";
import { config } from "./config";
import { getAnthropic, isAiAvailable, extractText, parseJsonResponse } from "./ai-client";

// ---------------------------------------------------------------------------
// Schema (defined inline because these are new tables not in schema.ts yet)
// ---------------------------------------------------------------------------

export const competitorReports = pgTable(
  "competitor_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    competitor: text("competitor").notNull(),
    reportDate: date("report_date").notNull(),
    rawContent: text("raw_content").notNull(),
    featuresShipped: jsonb("features_shipped")
      .notNull()
      .$type<FeatureShipped[]>()
      .default([]),
    gapsIdentified: jsonb("gaps_identified")
      .notNull()
      .$type<GapIdentified[]>()
      .default([]),
    summary: text("summary").notNull().default(""),
    modelUsed: text("model_used").notNull().default("claude-sonnet-4-6"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("competitor_reports_competitor").on(table.competitor),
    index("competitor_reports_date").on(table.reportDate),
    uniqueIndex("competitor_reports_unique").on(
      table.competitor,
      table.reportDate
    ),
  ]
);

export const intelScanRuns = pgTable("intel_scan_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  status: text("status").notNull().default("running"),
  competitorsScanned: integer("competitors_scanned").notNull().default(0),
  error: text("error"),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeatureShipped = {
  title: string;
  description: string;
  url?: string;
};

export type GapIdentified = {
  feature: string;
  priority: "high" | "medium" | "low";
  notes: string;
};

export type CompetitorReport = typeof competitorReports.$inferSelect;
export type IntelScanRun = typeof intelScanRuns.$inferSelect;

// ---------------------------------------------------------------------------
// Competitor definitions
// ---------------------------------------------------------------------------

const COMPETITORS = [
  {
    id: "github",
    name: "GitHub",
    changelogUrl: "https://github.blog/changelog/",
    rssUrl: "https://github.blog/changelog/feed/",
  },
  {
    id: "gitlab",
    name: "GitLab",
    changelogUrl: "https://about.gitlab.com/releases/",
    rssUrl: "https://about.gitlab.com/atom.xml",
  },
  {
    id: "bitbucket",
    name: "Bitbucket",
    changelogUrl: "https://bitbucket.org/blog/",
    rssUrl: "https://bitbucket.org/blog/rss",
  },
  {
    id: "linear",
    name: "Linear",
    changelogUrl: "https://linear.app/changelog",
    rssUrl: "https://linear.app/changelog/rss.xml",
  },
  {
    id: "vercel",
    name: "Vercel",
    changelogUrl: "https://vercel.com/changelog",
    rssUrl: null, // no RSS — scrape HTML
  },
  {
    id: "render",
    name: "Render",
    changelogUrl: "https://render.com/changelog",
    rssUrl: null, // no RSS — scrape HTML
  },
] as const;

export { COMPETITORS };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the ISO date string for the Monday of the current week. */
function getMondayOfCurrentWeek(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, …
  const diff = (day === 0 ? -6 : 1 - day);
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diff);
  return monday.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/** Strip HTML tags from a string. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Parse RSS/Atom XML by hand using regex.
 * Returns up to `limit` entries as plain text chunks.
 */
function parseRssItems(xml: string, limit = 20): string {
  const items: string[] = [];

  // Match <item> … </item> (RSS) or <entry> … </entry> (Atom)
  const itemRe = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRe.exec(xml)) !== null && items.length < limit) {
    const chunk = match[1];

    // title — try CDATA first, then plain
    const titleMatch =
      chunk.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) ||
      chunk.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]).trim() : "";

    // description / summary / content
    const descMatch =
      chunk.match(
        /<(?:description|summary|content(?::[a-z]+)?)[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/(?:description|summary|content(?::[a-z]+)?)>/i
      ) ||
      chunk.match(
        /<(?:description|summary|content(?::[a-z]+)?)[^>]*>([\s\S]*?)<\/(?:description|summary|content(?::[a-z]+)?)>/i
      );
    const desc = descMatch ? stripHtml(descMatch[1]).trim() : "";

    // link
    const linkMatch =
      chunk.match(/<link[^>]*href="([^"]+)"/i) ||
      chunk.match(/<link[^>]*>(https?:\/\/[^\s<]+)<\/link>/i);
    const link = linkMatch ? linkMatch[1].trim() : "";

    if (title || desc) {
      const parts = [title && `Title: ${title}`, desc && `Summary: ${desc.slice(0, 500)}`, link && `URL: ${link}`].filter(Boolean);
      items.push(parts.join("\n"));
    }
  }

  return items.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Fetch recent changelog content for a competitor.
 * Tries RSS first (if available), falls back to HTML scrape.
 * Never throws — returns empty string on any error.
 */
export async function fetchCompetitorContent(competitor: (typeof COMPETITORS)[number]): Promise<string> {
  const timeout = 15_000;

  // ---- Try RSS/Atom feed ----
  if (competitor.rssUrl) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const res = await fetch(competitor.rssUrl, {
        signal: ctrl.signal,
        headers: { "User-Agent": "Gluecron-Intel-Bot/1.0" },
      });
      clearTimeout(timer);
      if (res.ok) {
        const xml = await res.text();
        const parsed = parseRssItems(xml, 20);
        if (parsed.trim().length > 50) return parsed;
      }
    } catch {
      // fall through to HTML scrape
    }
  }

  // ---- Fall back to HTML changelog page ----
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const res = await fetch(competitor.changelogUrl, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Gluecron-Intel-Bot/1.0" },
    });
    clearTimeout(timer);
    if (res.ok) {
      const html = await res.text();
      const text = stripHtml(html);
      return text.slice(0, 8000);
    }
  } catch {
    // fall through
  }

  return "";
}

/**
 * Hardcoded summary of Gluecron's existing features.
 * Used as context when asking Claude to identify gaps.
 */
export function getGluecronFeatureSummary(): string {
  return `
Gluecron is an AI-native GitHub-alternative platform. It currently ships the following features:

CORE GIT HOSTING
- Bare git repository hosting with Smart HTTP (clone, push, pull)
- Branch management, tags, commits, file browser, diffs, blame
- Syntax highlighting for 40+ languages; Markdown rendering
- Raw file serving; semantic code search (Voyage AI embeddings)

AI FEATURES
- AI code review on every pull request (Claude-powered, inline annotations)
- AI merge conflict resolver (auto-repair on push)
- Spec-to-PR: describe a feature → Claude writes the code + opens a PR
- AI commit message generation
- AI PR summary / changelog generation
- AI code explain (explain any file or diff in plain English)
- AI test generation
- GateTest integration: push-time security + quality gate enforcement
- Auto-repair pipeline: lint/type/test failures auto-fixed by Claude
- AI-powered dep-updater (automated dependency PRs)

COLLABORATION
- Issue tracker with labels, comments, open/close/reopen
- Pull requests with reviews, inline comments, close/merge
- Branch comparison view
- Activity feed per repository
- Discussions (threaded, category-based)
- Wikis per repository
- Gists (standalone code snippets)
- Projects (kanban board)

PLATFORM
- Webhooks (HMAC-signed, per-event filtering, delivery log)
- Personal access tokens (SHA-256 hashed)
- OAuth 2.0 provider (developer apps can request scopes)
- Two-factor authentication (TOTP)
- Passkeys / WebAuthn
- SSH key management
- Organization accounts with team-level permissions
- Repository forking with fork count tracking
- Repository stars
- Repository topics / tags for discoverability
- Explore / discover public repos
- Contributors graph + commit activity
- Repo settings (description, visibility, delete)
- Branch protection rules (require PR, green gates, approvals)
- Repository templates
- Repository archival
- Site admin panel (user management, flags, audit log)
- Email digests + mention/assign notifications

DEPLOYMENT & PACKAGING
- GitHub Pages-style static site hosting (Pages)
- Package registry (Packages)
- Workflow / CI engine (YAML-based, similar to GitHub Actions)
- Deployment environments (staging, production)
- Deploy webhooks to external services (Render, Fly.io, etc.)
- Workflow secrets management (AES-256-GCM)
- Workflow artifact storage
`.trim();
}

type AnalysisResult = {
  featuresShipped: FeatureShipped[];
  gapsIdentified: GapIdentified[];
  summary: string;
};

/**
 * Send competitor changelog content to Claude for analysis.
 * Returns structured gap report. Never throws.
 */
export async function analyzeWithClaude(
  competitor: (typeof COMPETITORS)[number],
  rawContent: string,
  existingGluecronFeatures: string
): Promise<AnalysisResult> {
  const empty: AnalysisResult = {
    featuresShipped: [],
    gapsIdentified: [],
    summary: "Analysis unavailable.",
  };

  if (!isAiAvailable()) return empty;
  if (!rawContent.trim()) return empty;

  try {
    const anthropic = getAnthropic();

    const systemPrompt = `You are a product intelligence analyst for Gluecron, an AI-native GitHub-alternative platform.

Your job is to analyse a competitor's recent changelog and identify:
1. What features the competitor has shipped recently
2. Which of those features Gluecron does NOT already have (gaps)

When rating gap priority:
- HIGH: Core developer workflow features that many users would miss; features that give the competitor a meaningful advantage
- MEDIUM: Nice-to-have additions that improve UX or cover secondary use-cases
- LOW: Niche, very org-specific, or features that few users would care about

Always respond with ONLY valid JSON matching this exact schema (no surrounding prose):
{
  "featuresShipped": [
    { "title": "string", "description": "string", "url": "string or omit" }
  ],
  "gapsIdentified": [
    { "feature": "string", "priority": "high|medium|low", "notes": "string" }
  ],
  "summary": "2-sentence overall summary of what this competitor is focused on and what the biggest threat to Gluecron is."
}`;

    const userPrompt = `Competitor: ${competitor.name}
Changelog URL: ${competitor.changelogUrl}

--- GLUECRON EXISTING FEATURES ---
${existingGluecronFeatures}

--- ${competitor.name.toUpperCase()} RECENT CHANGELOG ---
${rawContent.slice(0, 12000)}

Analyse the changelog above. List all features shipped. Then identify gaps — features the competitor has that Gluecron does NOT already have based on the list above. Rate each gap's priority. Return only JSON.`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: userPrompt }],
      system: systemPrompt,
    });

    const text = extractText(message);
    const parsed = parseJsonResponse<AnalysisResult>(text);

    if (!parsed) return empty;

    return {
      featuresShipped: Array.isArray(parsed.featuresShipped)
        ? parsed.featuresShipped
        : [],
      gapsIdentified: Array.isArray(parsed.gapsIdentified)
        ? parsed.gapsIdentified
        : [],
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : "Analysis unavailable.",
    };
  } catch (err) {
    console.error(`[competitive-intel] Claude analysis failed for ${competitor.name}:`, err);
    return empty;
  }
}

/**
 * Main orchestrator. Run this from the admin UI or a scheduled job.
 * Never throws — returns a summary object even on partial failure.
 */
export async function runIntelligenceScan(): Promise<{
  success: boolean;
  reportsCreated: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let reportsCreated = 0;
  let runId: string | null = null;

  // Create a scan run record
  try {
    const [run] = await db
      .insert(intelScanRuns)
      .values({ status: "running" })
      .returning({ id: intelScanRuns.id });
    runId = run?.id ?? null;
  } catch (err) {
    console.error("[competitive-intel] Failed to create scan run record:", err);
    // Continue anyway
  }

  const weekOf = getMondayOfCurrentWeek();
  const gluecronFeatures = getGluecronFeatureSummary();

  for (const competitor of COMPETITORS) {
    try {
      // Check if a report already exists for this week
      const [existing] = await db
        .select({ id: competitorReports.id })
        .from(competitorReports)
        .where(
          and(
            eq(competitorReports.competitor, competitor.id),
            eq(competitorReports.reportDate, weekOf)
          )
        )
        .limit(1);

      if (existing) {
        console.log(`[competitive-intel] Skipping ${competitor.name} — report for ${weekOf} already exists`);
        continue;
      }

      // Fetch content
      console.log(`[competitive-intel] Fetching ${competitor.name}...`);
      const rawContent = await fetchCompetitorContent(competitor);

      if (!rawContent.trim()) {
        errors.push(`${competitor.name}: no content fetched`);
        console.warn(`[competitive-intel] ${competitor.name}: empty content, skipping`);
        continue;
      }

      // Analyse with Claude
      console.log(`[competitive-intel] Analysing ${competitor.name} with Claude...`);
      const analysis = await analyzeWithClaude(competitor, rawContent, gluecronFeatures);

      // Insert report
      await db.insert(competitorReports).values({
        competitor: competitor.id,
        reportDate: weekOf,
        rawContent,
        featuresShipped: analysis.featuresShipped,
        gapsIdentified: analysis.gapsIdentified,
        summary: analysis.summary,
        modelUsed: "claude-sonnet-4-6",
      });

      reportsCreated++;
      console.log(`[competitive-intel] ${competitor.name}: report created (${analysis.featuresShipped.length} features, ${analysis.gapsIdentified.length} gaps)`);
    } catch (err) {
      const msg = `${competitor.name}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(`[competitive-intel] Error processing ${competitor.name}:`, err);
    }
  }

  // Update scan run record
  if (runId) {
    try {
      await db
        .update(intelScanRuns)
        .set({
          completedAt: new Date(),
          status: errors.length === COMPETITORS.length ? "failed" : "completed",
          competitorsScanned: reportsCreated,
          error: errors.length > 0 ? errors.slice(0, 5).join("; ") : null,
        })
        .where(eq(intelScanRuns.id, runId));
    } catch (err) {
      console.error("[competitive-intel] Failed to update scan run record:", err);
    }
  }

  return {
    success: reportsCreated > 0 || errors.length === 0,
    reportsCreated,
    errors,
  };
}

/**
 * Returns the most recent report for each competitor.
 */
export async function getLatestReports(): Promise<CompetitorReport[]> {
  try {
    // Use a DISTINCT ON query to get the latest report per competitor
    const rows = await db.execute(sql`
      SELECT DISTINCT ON (competitor)
        id, competitor, report_date, raw_content,
        features_shipped, gaps_identified, summary,
        model_used, created_at
      FROM competitor_reports
      ORDER BY competitor, report_date DESC
    `);

    return (rows.rows as CompetitorReport[]).map((r) => ({
      ...r,
      featuresShipped: (r.featuresShipped ?? []) as FeatureShipped[],
      gapsIdentified: (r.gapsIdentified ?? []) as GapIdentified[],
    }));
  } catch (err) {
    console.error("[competitive-intel] getLatestReports:", err);
    return [];
  }
}

/**
 * Returns historical reports for one competitor, most recent first.
 */
export async function getReportHistory(
  competitor: string,
  limit = 12
): Promise<CompetitorReport[]> {
  try {
    const rows = await db
      .select()
      .from(competitorReports)
      .where(eq(competitorReports.competitor, competitor))
      .orderBy(desc(competitorReports.reportDate))
      .limit(limit);

    return rows.map((r) => ({
      ...r,
      featuresShipped: (r.featuresShipped ?? []) as FeatureShipped[],
      gapsIdentified: (r.gapsIdentified ?? []) as GapIdentified[],
    }));
  } catch (err) {
    console.error("[competitive-intel] getReportHistory:", err);
    return [];
  }
}

/**
 * Returns the most recent scan run record.
 */
export async function getLastScanRun(): Promise<IntelScanRun | null> {
  try {
    const [row] = await db
      .select()
      .from(intelScanRuns)
      .orderBy(desc(intelScanRuns.startedAt))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}
