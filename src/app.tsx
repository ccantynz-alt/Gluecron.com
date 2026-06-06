import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { etag } from "hono/etag";
// BLOCK O2 — shared error-page surface (404 / 500 / 403).
import { NotFoundPage, ServerErrorPage } from "./views/error-page";
import { reportError } from "./lib/observability";
import { requestContext } from "./middleware/request-context";
import { rateLimit } from "./middleware/rate-limit";
import gitRoutes from "./routes/git";
import apiRoutes from "./routes/api";
import apiV2Routes from "./routes/api-v2";
import apiDocsRoutes from "./routes/api-docs";
import buildAgentSpecRoutes from "./routes/build-agent-spec";
import pullsDashboardRoutes from "./routes/pulls-dashboard";
import issuesDashboardRoutes from "./routes/issues-dashboard";
import inboxRoutes from "./routes/inbox";
import activityRoutes from "./routes/activity";
import authRoutes from "./routes/auth";
import passwordResetRoutes from "./routes/password-reset";
import emailVerificationRoutes from "./routes/email-verification";
import magicLinkRoutes from "./routes/magic-link";
import settingsRoutes from "./routes/settings";
import settings2faRoutes from "./routes/settings-2fa";
import settingsAgentsRoutes from "./routes/settings-agents";
import settingsIntegrationsRoutes from "./routes/settings-integrations";
import integrationsChatRoutes from "./routes/integrations-chat";
import agentsRoutes from "./routes/agents";
import issueRoutes from "./routes/issues";
import commentModerationRoutes from "./routes/comment-moderation";
import repoSettings from "./routes/repo-settings";
import collaboratorRoutes from "./routes/collaborators";
import teamCollaboratorRoutes from "./routes/team-collaborators";
import invitesRoutes from "./routes/invites";
import liveEventsRoutes from "./routes/live-events";
import prLiveRoutes from "./routes/pr-live";
import compareRoutes from "./routes/compare";
import pullRoutes from "./routes/pulls";
import prSandboxRoutes from "./routes/pr-sandbox";
import devEnvRoutes from "./routes/dev-env";
import editorRoutes from "./routes/editor";
import forkRoutes from "./routes/fork";
import webhookRoutes from "./routes/webhooks";
import exploreRoutes from "./routes/explore";
import tokenRoutes from "./routes/tokens";
import contributorRoutes from "./routes/contributors";
import healthRoutes from "./routes/health-probe";
import healthDashboardRoutes from "./routes/health";
import statusRoutes from "./routes/status";
import adminStatusRoutes from "./routes/admin-status";
import helpRoutes from "./routes/help";
import changelogRoutes from "./routes/changelog";
import marketingRoutes from "./routes/marketing";
import pricingRoutes from "./routes/pricing";
import seoRoutes from "./routes/seo";
import versionRoutes from "./routes/version";
import { platformStatus } from "./routes/platform-status";
import publicStatsRoutes from "./routes/public-stats";
import demoRoutes from "./routes/demo";
import insightRoutes from "./routes/insights";
import doraRoutes from "./routes/dora";
import dashboardRoutes from "./routes/dashboard";
import legalRoutes from "./routes/legal";
import legalDmcaRoutes from "./routes/legal/dmca";
import legalTermsRoutes from "./routes/legal/terms";
import legalPrivacyRoutes from "./routes/legal/privacy";
import legalAcceptableUseRoutes from "./routes/legal/acceptable-use";
import importRoutes from "./routes/import";
import importBulkRoutes from "./routes/import-bulk";
import importSecretsRoutes from "./routes/import-secrets";
import migrationRoutes from "./routes/migrations";
import specsRoutes from "./routes/specs";
import refactorRoutes from "./routes/refactors";
import webRoutes from "./routes/web";
import hookRoutes from "./routes/hooks";
import eventsRoutes from "./routes/events";
import passkeyRoutes from "./routes/passkeys";
import oauthRoutes from "./routes/oauth";
import developerAppsRoutes from "./routes/developer-apps";
import themeRoutes from "./routes/theme";
import auditRoutes from "./routes/audit";
import reactionRoutes from "./routes/reactions";
import savedReplyRoutes from "./routes/saved-replies";
import deploymentRoutes from "./routes/deployments";
import orgRoutes from "./routes/orgs";
import notificationRoutes from "./routes/notifications";
import onboardingRoutes from "./routes/onboarding";
import adminRoutes from "./routes/admin";
import adminDeploysRoutes from "./routes/admin-deploys";
import adminDeploysPageRoutes from "./routes/admin-deploys-page";
import adminServerTargetsRoutes from "./routes/admin-server-targets";
import deployTargetsRoutes from "./routes/deploy-targets";
import claudeWebRoutes from "./routes/claude-web";
import adminOpsRoutes from "./routes/admin-ops";
import adminSelfHostRoutes from "./routes/admin-self-host";
import adminDiagnoseRoutes from "./routes/admin-diagnose";
import adminIntegrationsRoutes from "./routes/admin-integrations";
import adminAdvancementRoutes from "./routes/admin-advancement";
import advisoriesRoutes from "./routes/advisories";
import aiChangelogRoutes from "./routes/ai-changelog";
import aiExplainRoutes from "./routes/ai-explain";
import aiTestsRoutes from "./routes/ai-tests";
import askRoutes from "./routes/ask";
import repoChatRoutes from "./routes/repo-chat";
import personalChatRoutes from "./routes/personal-chat";
import billingRoutes from "./routes/billing";
import billingUsageRoutes from "./routes/billing-usage";
import stripeWebhookRoutes from "./routes/stripe-webhook";
import codeScanningRoutes from "./routes/code-scanning";
import commitStatusesRoutes from "./routes/commit-statuses";
import copilotRoutes from "./routes/copilot";
import depUpdaterRoutes from "./routes/dep-updater";
import depsRoutes from "./routes/deps";
import discussionsRoutes from "./routes/discussions";
import environmentsRoutes from "./routes/environments";
import previewsRoutes from "./routes/previews";
import docsTrackingRoutes from "./routes/docs-tracking";
import followsRoutes from "./routes/follows";
import gatesRoutes from "./routes/gates";
import gistsRoutes from "./routes/gists";
import graphqlRoutes from "./routes/graphql";
import mcpRoutes from "./routes/mcp";
import marketplaceRoutes from "./routes/marketplace";
import marketplaceAgentsRoutes from "./routes/marketplace-agents";
import mergeQueueRoutes from "./routes/merge-queue";
import mirrorsRoutes from "./routes/mirrors";
import orgInsightsRoutes from "./routes/org-insights";
import packagesRoutes from "./routes/packages";
import packagesApiRoutes from "./routes/packages-api";
import pagesRoutes from "./routes/pages";
import projectsRoutes from "./routes/projects";
import protectedTagsRoutes from "./routes/protected-tags";
import pwaRoutes from "./routes/pwa";
import installRoutes from "./routes/install";
import dxtRoutes from "./routes/dxt";
import connectClaudeRoutes from "./routes/connect-claude";
import claudeDeployRoutes from "./routes/claude-deploy";
import claudeIntegration from "./routes/claude-integration";
import connectRoutes from "./routes/connect";
import pushWatchRoutes from "./routes/push-watch";
import orgSecretsRoutes from "./routes/org-secrets";
import releasesRoutes from "./routes/releases";
import requiredChecksRoutes from "./routes/required-checks";
import rulesetsRoutes from "./routes/rulesets";
import searchRoutes from "./routes/search";
import semanticSearchRoutes from "./routes/semantic-search";
import signingKeysRoutes from "./routes/signing-keys";
import sponsorsRoutes from "./routes/sponsors";
import ssoRoutes from "./routes/sso";
import githubOauthRoutes from "./routes/github-oauth";
import googleOauthRoutes from "./routes/google-oauth";
import symbolsRoutes from "./routes/symbols";
import templatesRoutes from "./routes/templates";
import trafficRoutes from "./routes/traffic";
import wikisRoutes from "./routes/wikis";
import workflowsRoutes from "./routes/workflows";
import workflowArtifactsRoutes from "./routes/workflow-artifacts";
import workflowSecretsRoutes from "./routes/workflow-secrets";
import sleepModeRoutes from "./routes/sleep-mode";
import standupRoutes from "./routes/standups";
import vsGithubRoutes from "./routes/vs-github";
import voiceRoutes from "./routes/voice-to-pr";
import playgroundRoutes from "./routes/playground";
import crossRepoSearchRoutes from "./routes/cross-repo-search";
import pushNotifRoutes from "./routes/push-notifications";
import velocityRoutes from "./routes/velocity";
import { staleBranchRoutes } from "./routes/stale-branches";
import pulseRoutes from "./routes/pulse";
import healthScoreRoutes from "./routes/health-score";
import hotFilesRoutes from "./routes/hot-files";
import developerProgramRoutes from "./routes/developer-program";
import { authRateLimit, gitRateLimit, searchRateLimit } from "./middleware/rate-limit";
import { csrfToken, csrfProtect } from "./middleware/csrf";
import { noCache } from "./middleware/no-cache";

import type { AuthEnv } from "./middleware/auth";
import { softAuth } from "./middleware/auth";

const app = new Hono<AuthEnv>();

// Request context (request ID, start time) runs before everything else
app.use("*", requestContext);
// Middleware — compression first (wraps all responses)
app.use("*", compress());

// ETag middleware — returns 304 Not Modified on unchanged responses.
// Saves ~95% bandwidth on repeat visits. Skipped on git protocol +
// SSE + the API surface where it would interfere with streaming.
app.use("*", async (c, next) => {
  const p = c.req.path;
  if (
    p.includes(".git/") ||
    p.startsWith("/live-events") ||
    p.startsWith("/api/events/deploy") ||
    p.startsWith("/admin/status") ||
    // PR live co-editing SSE stream — never etag streaming responses.
    /^\/api\/v2\/pulls\/[^/]+\/live(\/|$)/.test(p)
  ) {
    return next();
  }
  return etag()(c, next);
});

// Cache-Control middleware — sets sensible defaults on public, anonymous
// requests. Crontech (when wired as our edge layer) and downstream
// browsers will honor these. Auth'd users get private,no-store
// automatically — we never cache responses tied to a session.
app.use("*", async (c, next) => {
  await next();
  // Don't overwrite explicit headers set by route handlers — BUT the
  // ETag middleware unconditionally sets "private, no-cache, must-
  // revalidate" so we have to treat that specific value as "no
  // policy chosen yet" and apply ours. Any route that explicitly set
  // a different cache-control wins.
  const existing = c.res.headers.get("cache-control");
  const etagDefault =
    existing === "private, no-cache, must-revalidate" ||
    existing === "no-cache";
  if (existing && !etagDefault) return;
  // Anything past auth: private + no-store (avoid leaking session
  // content into shared caches). softAuth runs before this on the
  // request, but the response side is what we're stamping.
  const hasSession = c.req.header("cookie")?.includes("session=") ?? false;
  const p = c.req.path;
  // Always private for known-authed paths regardless of cookie.
  if (
    p.startsWith("/admin") ||
    p.startsWith("/settings") ||
    p.startsWith("/dashboard") ||
    p.startsWith("/notifications") ||
    p.startsWith("/connect/") ||
    hasSession
  ) {
    c.res.headers.set("cache-control", "private, no-store");
    return;
  }
  // Public marketing surfaces — short edge cache, longer browser cache,
  // stale-while-revalidate so the user never waits on a stale fetch.
  const isMarketing =
    p === "/" ||
    p === "/features" ||
    p === "/pricing" ||
    p === "/about" ||
    p === "/vs-github" ||
    p === "/explore" ||
    p === "/help" ||
    p === "/changelog" ||
    p.startsWith("/legal/") ||
    p === "/terms" ||
    p === "/privacy" ||
    p === "/acceptable-use" ||
    p.startsWith("/docs/");
  if (isMarketing) {
    c.res.headers.set(
      "cache-control",
      "public, max-age=60, s-maxage=300, stale-while-revalidate=86400"
    );
    return;
  }
  // Public repo browse pages — cache aggressively. Edge invalidates
  // on push via the post-receive hook (future Crontech surge purge).
  if (/^\/[^/]+\/[^/]+(\/.*)?$/.test(p) && c.req.method === "GET") {
    c.res.headers.set(
      "cache-control",
      "public, max-age=30, s-maxage=120, stale-while-revalidate=600"
    );
    return;
  }
  // Default: don't cache anything we haven't explicitly opted in.
  c.res.headers.set("cache-control", "private, no-store");
});
// Logger only on non-git routes to avoid overhead on clone/push
app.use("*", async (c, next) => {
  if (c.req.path.includes(".git/")) return next();
  return logger()(c, next);
});
app.use("/api/*", cors());
// Global softAuth — populates c.get("user") for every downstream middleware
// + route. This was previously per-route, which meant rate-limit middleware
// (and anything else inspecting auth state) always saw a null user. Keep
// individual routes free to add requireAuth on top for hard gating; this
// just establishes the user object cheaply.
app.use("*", softAuth);

// Force-revalidate HTML on every request — kills browser cache holding stale
// pre-redesign markup. JSON / static assets keep their own cache rules; only
// text/html responses get the no-cache stamp. Without this, every push to
// main left users staring at cached 80s-looking pages from before the design
// landed.
//
// We deliberately use `private, no-cache, must-revalidate` rather than
// `no-store`. `no-store` disables Safari/Chrome's back-forward cache (bfcache),
// which makes every Back/Forward press a cold server round-trip — that
// contributed to the "every nav feels like a fresh login" UX complaint.
// `no-cache` still revalidates on direct fetch but lets bfcache hold the
// page in memory between navigations.
app.use("*", async (c, next) => {
  await next();
  const ct = c.res.headers.get("content-type") || "";
  if (ct.startsWith("text/html")) {
    c.header("cache-control", "private, no-cache, must-revalidate");
  }
});
// Rate-limit API + auth endpoints.
//
// `/api/*`: 1000/min per IP — generous so an admin clicking around the
// operator console (or a CDN/proxy concentrating multiple users behind one
// IP) doesn't hit the wall. Bot-resistant headroom comes from the auth
// rate limits below, not this one.
//
// `authedMultiplier` is set but only fires when an upstream middleware has
// already populated c.get("user") — most app.use() chains apply softAuth
// per-route, so the multiplier is best-effort. Keep the anonymous base
// high enough that humans never feel it.
//
// Skip-paths: dashboard plumbing endpoints that the layout polls on a
// fixed cadence and that we don't want consuming any bucket:
//   /api/version              — layout polls every 15s
//   /api/notifications/count  — nav bell unread-count fetcher
//   /pwa/vapid-public-key     — fetched once per push-notification opt-in
app.use(
  "/api/*",
  rateLimit(1000, 60_000, "api", {
    authedMultiplier: 4,
    skipPaths: ["/api/version", "/api/notifications/count", "/pwa/vapid-public-key"],
  })
);
app.use("/login", rateLimit(20, 60_000, "login"));
app.use("/register", rateLimit(10, 60_000, "register"));
// BLOCK P1 — throttle forgot-password to deter enumeration + mail spam.
app.use("/forgot-password", rateLimit(5, 60_000, "forgot-password"));
// BLOCK Q2 — throttle magic-link sign-in for the same reason.
app.use("/login/magic", rateLimit(5, 60_000, "magic-link"));

// CSRF protection — set token on all requests, validate on mutations
app.use("*", csrfToken);
app.use("*", csrfProtect);

// Rate limit auth routes
app.use("/login", authRateLimit);
app.use("/register", authRateLimit);

// Rate limit git operations
app.use("/:owner/:repo.git/*", gitRateLimit);

// Rate limit search
app.use("/:owner/:repo/search", searchRateLimit);
app.use("/explore", searchRateLimit);

// No-cache for HTML — ensures browsers and proxies never serve stale pages.
// The middleware only stamps text/html responses so static assets keep
// their own cache policies unchanged.
app.use("*", noCache);

// Git Smart HTTP protocol routes (must be before web routes)
app.route("/", gitRoutes);

// REST API v1 (legacy)
app.route("/", apiRoutes);

// Block L3 — /demo + /api/v2/demo/* live demo endpoints. Mounted BEFORE
// apiV2Routes so the /api/v2/demo/* JSON endpoints win over the v2 base
// router's catch-shape, and BEFORE adminRoutes so the live /demo page
// wins over the legacy /demo redirect in src/routes/admin.tsx.
app.route("/", demoRoutes);

// REST API v2 (basePath /api/v2)
app.route("/", apiV2Routes);

// Agent multiplayer v1 — /api/v2/agents/* (sessions, leases, usage).
// Mounted alongside apiV2Routes (its own basePath, no path conflict).
app.route("/", agentsRoutes);

// Inbound API hooks (GateTest callback + backup PAT-authed /api/v1/gate-runs)
app.route("/", hookRoutes);
app.route("/api/events", eventsRoutes);

// API documentation
app.route("/", apiDocsRoutes);
app.route("/", buildAgentSpecRoutes);
// PR command center — global PR dashboard with AI/GateTest/auto-merge signal
app.route("/", pullsDashboardRoutes);
// Issue command center — global issue dashboard with AI-triage + autopilot signal
app.route("/", issuesDashboardRoutes);
// Personal activity timeline — every event across the user's repos, with
// AI-driven events surfaced separately (the Gluecron differentiator).
app.route("/", activityRoutes);
// Unified inbox — mentions + review requests + CI failures + AI events in one timeline
app.route("/", inboxRoutes);
// AI standup feed — daily / weekly Claude-generated team brief
app.route("/", standupRoutes);

// Auth routes (register, login, logout)
app.route("/", authRoutes);

// BLOCK P1 — Password reset (forgot-password + reset-password)
app.route("/", passwordResetRoutes);

// BLOCK P2 — Email verification (verify-email + resend)
app.route("/", emailVerificationRoutes);

// BLOCK Q2 — Magic-link sign-in (/login/magic + callback)
app.route("/", magicLinkRoutes);

// Settings routes (profile, SSH keys)
app.route("/", settingsRoutes);

// 2FA / TOTP settings (Block B4)
app.route("/", settings2faRoutes);

// Agent multiplayer — /settings/agents management UI
app.route("/", settingsAgentsRoutes);

// Chat integrations — Slack / Discord / Teams (/settings/integrations
// + /api/v2/integrations/{slack,discord}/*). See src/lib/chat-bot.ts.
app.route("/", settingsIntegrationsRoutes);
app.route("/", integrationsChatRoutes);

// WebAuthn / passkey routes (Block B5)
app.route("/", passkeyRoutes);

// OAuth 2.0 provider (Block B6)
app.route("/", oauthRoutes);
app.route("/", developerAppsRoutes);

// Theme toggle (dark/light cookie)
app.route("/", themeRoutes);

// Audit log UI
app.route("/", auditRoutes);

// Reactions API (issues, PRs, comments)
app.route("/", reactionRoutes);

// Saved replies (per-user canned comment templates)
app.route("/", savedReplyRoutes);

// Environments + deployment history UI
app.route("/", deploymentRoutes);

// Organizations + teams (Block B1)
app.route("/", orgRoutes);

// API tokens
app.route("/", tokenRoutes);

// Notifications
app.route("/", notificationRoutes);

// Repo settings (description, visibility, delete)
app.route("/", repoSettings);

// Repo collaborators (add/list/remove)
app.route("/", collaboratorRoutes);

// Team-based repo collaborators (invite a whole team)
app.route("/", teamCollaboratorRoutes);

// Collaborator invite accept flow (token-based)
app.route("/", invitesRoutes);

// Real-time SSE endpoint (topic-based live updates)
app.route("/", liveEventsRoutes);

// PR live co-editing — presence + cursors + content sync via SSE.
app.route("/", prLiveRoutes);

// Webhooks management
app.route("/", webhookRoutes);

// Compare view (branch diffs)
app.route("/", compareRoutes);

// Issue tracker
app.route("/", issueRoutes);

// Comment moderation queue — owner-only `/:owner/:repo/comments/pending`
// + per-row approve/reject/spam actions. Mounted before `pullRoutes` so
// the `/:owner/:repo/comments/*` paths resolve before the broader PR
// patterns kick in.
app.route("/", commentModerationRoutes);

// Pull requests
app.route("/", pullRoutes);
// PR sandboxes — runnable per-PR environments. Migration 0067.
app.route("/", prSandboxRoutes);

// Cloud dev environments — hosted VS Code in the browser. Migration 0072.
app.route("/", devEnvRoutes);

// Fork
app.route("/", forkRoutes);

// Web file editor
app.route("/", editorRoutes);

// Contributors
app.route("/", contributorRoutes);

// Health liveness + metrics endpoints
app.route("/", healthRoutes);

// Cross-product platform status (public, CORS-open — see docs/PLATFORM_STATUS.md)
app.route("/api/platform-status", platformStatus);

// Block L4 — Public stats counters (powers landing-page social proof)
app.route("/", publicStatsRoutes);

// Block L3 — Live /demo page + /api/v2/demo/* endpoints
app.route("/", demoRoutes);

// Public /status — human-readable platform health page
app.route("/", statusRoutes);

// BLOCK S4 — Site-admin synthetic-monitor dashboard (/admin/status).
// Mounted near the public status route so the two surfaces are visible
// side-by-side; routes are gated by isSiteAdmin internally.
app.route("/", adminStatusRoutes);

// /help — quickstart + API cheatsheet
app.route("/", helpRoutes);

// L8 — public /pricing page (free-tier polish). Mounted BEFORE marketing
// so the new editorial pricing layout wins the route; the legacy marketing
// pricing remains as a safety net but is shadowed at the router.
app.route("/", pricingRoutes);

// /changelog — manually curated platform release history
app.route("/", changelogRoutes);

// /pricing, /features, /about — marketing surface
app.route("/", marketingRoutes);

// /developer-program — partner + marketplace revenue-share page
app.route("/", developerProgramRoutes);

// SEO: robots.txt + sitemap.xml
app.route("/", seoRoutes);

// /api/version — live build SHA + uptime; client poller uses this to
// surface 'New version available — reload' banners on deploy.
app.route("/", versionRoutes);

// Health dashboard (per-repo health page)
app.route("/", healthDashboardRoutes);

// Block R1 — site-admin operations console. MUST be mounted BEFORE
// insightRoutes because its POST `/:owner/:repo/rollback` catch-all would
// otherwise intercept `/admin/ops/rollback` (matching :owner=admin :repo=ops).
app.route("/", adminOpsRoutes);
// BLOCK W — Self-host status + bootstrap dashboard.
app.route("/", adminSelfHostRoutes);
// BLOCK X — AI health-scan diagnose page (/admin/diagnose).
app.route("/", adminDiagnoseRoutes);

// Insights (time-travel, dependencies, rollback)
app.route("/", insightRoutes);

// DORA metrics page (/:owner/:repo/insights/dora)
app.route("/", doraRoutes);

// Command center dashboard
app.route("/", dashboardRoutes);

// Legal pages (terms, privacy, AUP)
app.route("/", legalRoutes);
// Long-form legal sub-pages — /legal/{terms,privacy,acceptable-use,dmca}.
// The main `legal.tsx` serves the short canonical paths (/terms, /privacy,
// /acceptable-use); these are the formal versions that the legal pages
// internally link to each other.
app.route("/", legalTermsRoutes);
app.route("/", legalPrivacyRoutes);
app.route("/", legalAcceptableUseRoutes);
app.route("/", legalDmcaRoutes);

// GitHub import / migration
app.route("/", importRoutes);
app.route("/", importBulkRoutes);
app.route("/", importSecretsRoutes);
app.route("/", migrationRoutes);

// Spec-to-PR (experimental AI-generated draft PRs)
app.route("/", specsRoutes);
app.route("/", refactorRoutes);

// Explore page
app.route("/", exploreRoutes);

// Onboarding
app.route("/", onboardingRoutes);

// Admin + feature routes
app.route("/", adminRoutes);
app.route("/", adminIntegrationsRoutes);
app.route("/", adminAdvancementRoutes);
app.route("/", adminDeploysRoutes);
app.route("/", adminDeploysPageRoutes);
app.route("/", adminServerTargetsRoutes);
app.route("/", deployTargetsRoutes);
app.route("/", claudeWebRoutes);
// Note: adminOpsRoutes is mounted earlier (before insightRoutes) — see comment above.
app.route("/", advisoriesRoutes);
app.route("/", aiChangelogRoutes);
app.route("/", aiExplainRoutes);
app.route("/", aiTestsRoutes);
app.route("/", askRoutes);
app.route("/", repoChatRoutes);
// Personal cross-repo chat — `/chat` (user-scoped). Mounted alongside
// repoChatRoutes so the two surfaces share the catch-all priority.
app.route("/", personalChatRoutes);
app.route("/", billingRoutes);
app.route("/", billingUsageRoutes);
app.route("/", stripeWebhookRoutes);
app.route("/", codeScanningRoutes);
app.route("/", commitStatusesRoutes);
app.route("/", copilotRoutes);
app.route("/", depUpdaterRoutes);
app.route("/", depsRoutes);
app.route("/", discussionsRoutes);
app.route("/", environmentsRoutes);
app.route("/", previewsRoutes);
app.route("/", docsTrackingRoutes);
app.route("/", followsRoutes);
app.route("/", gatesRoutes);
app.route("/", gistsRoutes);
app.route("/", graphqlRoutes);
app.route("/", mcpRoutes);
app.route("/", marketplaceRoutes);
app.route("/", marketplaceAgentsRoutes);
app.route("/", mergeQueueRoutes);
app.route("/", mirrorsRoutes);
app.route("/", orgInsightsRoutes);
app.route("/", packagesRoutes);
app.route("/", packagesApiRoutes);
app.route("/", pagesRoutes);
app.route("/", projectsRoutes);
app.route("/", protectedTagsRoutes);
app.route("/", pwaRoutes);
app.route("/", installRoutes);
// BLOCK Q1 — /gluecron.dxt download (Claude Desktop one-click extension)
app.route("/", dxtRoutes);
// Connect Claude — user-facing one-click MCP setup (/connect/claude). Mounted
// next to the other one-click flows (install.sh + .dxt) for surface symmetry.
app.route("/", connectClaudeRoutes);
// Claude Code Integration Receiver — /api/claude/connect + /api/claude/session.
app.route("/", claudeIntegration);
// Connect guide — public onboarding page (/connect/claude-guide).
app.route("/", connectRoutes);
// Push Watch — per-commit live status (gates + deploy + latency) at /:owner/:repo/push/:sha
app.route("/", pushWatchRoutes);
// Org Secrets Manager — BLOCK M2 — /orgs/:slug/settings/secrets
app.route("/", orgSecretsRoutes);
// Cross-repo code search — BLOCK M3 — /search/code + /api/search/code
app.route("/", crossRepoSearchRoutes);
// Browser push notifications — BLOCK M4 — /settings/notifications/push + /api/push/*
app.route("/", pushNotifRoutes);
// Developer Velocity Dashboard — BLOCK M9 — /:owner/:repo/insights/velocity
app.route("/", velocityRoutes);
// Stale Branch Cleanup — BLOCK M10 — /:owner/:repo/branches/stale
app.route("/", staleBranchRoutes);
// Repository Pulse — BLOCK M12 — /:owner/:repo/pulse
app.route("/", pulseRoutes);
// Repository Health Score — BLOCK M14 — /:owner/:repo/insights/health
app.route("/", healthScoreRoutes);
// Hot Files Heatmap — BLOCK M16 — /:owner/:repo/insights/hotfiles
app.route("/", hotFilesRoutes);
// Hosted Claude tool-use loops — paste loop, get endpoint, billing meter.
// See src/routes/claude-deploy.tsx + src/lib/hosted-claude-loop.ts.
app.route("/", claudeDeployRoutes);
app.route("/", releasesRoutes);
app.route("/", requiredChecksRoutes);
app.route("/", rulesetsRoutes);
app.route("/", searchRoutes);
app.route("/", semanticSearchRoutes);
app.route("/", signingKeysRoutes);
app.route("/", sponsorsRoutes);
app.route("/", ssoRoutes);
app.route("/", githubOauthRoutes);
app.route("/", googleOauthRoutes);
app.route("/", symbolsRoutes);
app.route("/", templatesRoutes);
app.route("/", trafficRoutes);
app.route("/", wikisRoutes);
app.route("/", workflowsRoutes);
app.route("/", workflowArtifactsRoutes);
app.route("/", workflowSecretsRoutes);
app.route("/", sleepModeRoutes);
app.route("/", vsGithubRoutes);

// Voice-to-PR — phone-first dictation → spec or issue
app.route("/", voiceRoutes);

// Block Q3 — Anonymous playground (`/play`, `/play/claim`). Mounted
// before the web catch-all so the bare `/play` literal wins over the
// `/:owner` user-profile route.
app.route("/", playgroundRoutes);

// Web UI (catch-all, must be last)
app.route("/", webRoutes);

// Global 404 — BLOCK O2 routes the shared `NotFoundPage` view so
// the markup stays consistent with /500 and the admin /403 page.
app.notFound((c) => {
  const user = c.get("user") ?? null;
  return c.html(
    <NotFoundPage user={user} method={c.req.method} path={c.req.path} />,
    404
  );
});

// Global error handler — BLOCK O2 uses the shared `ServerErrorPage`
// view. Trace block only shown outside production.
app.onError((err, c) => {
  reportError(err, {
    requestId: c.get("requestId"),
    path: c.req.path,
    method: c.req.method,
  });
  // Prefer the inbound `x-request-id` header (LB-supplied) and fall
  // back to the context value set by request-context middleware.
  const requestId =
    c.req.header("x-request-id") ||
    ((c.get("requestId" as never) as string | undefined) ?? undefined);
  const user = c.get("user") ?? null;
  const trace =
    process.env.NODE_ENV !== "production" && err && err.message
      ? err.message
      : undefined;
  return c.html(
    <ServerErrorPage user={user} requestId={requestId} trace={trace} />,
    500
  );
});

export default app;
