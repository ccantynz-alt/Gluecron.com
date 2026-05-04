import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { Layout } from "./views/layout";
import { reportError } from "./lib/observability";
import { requestContext } from "./middleware/request-context";
import { rateLimit } from "./middleware/rate-limit";
import gitRoutes from "./routes/git";
import apiRoutes from "./routes/api";
import apiV2Routes from "./routes/api-v2";
import apiDocsRoutes from "./routes/api-docs";
import authRoutes from "./routes/auth";
import settingsRoutes from "./routes/settings";
import settings2faRoutes from "./routes/settings-2fa";
import issueRoutes from "./routes/issues";
import repoSettings from "./routes/repo-settings";
import collaboratorRoutes from "./routes/collaborators";
import teamCollaboratorRoutes from "./routes/team-collaborators";
import invitesRoutes from "./routes/invites";
import liveEventsRoutes from "./routes/live-events";
import compareRoutes from "./routes/compare";
import pullRoutes from "./routes/pulls";
import editorRoutes from "./routes/editor";
import forkRoutes from "./routes/fork";
import webhookRoutes from "./routes/webhooks";
import exploreRoutes from "./routes/explore";
import tokenRoutes from "./routes/tokens";
import contributorRoutes from "./routes/contributors";
import healthRoutes from "./routes/health-probe";
import healthDashboardRoutes from "./routes/health";
import statusRoutes from "./routes/status";
import helpRoutes from "./routes/help";
import marketingRoutes from "./routes/marketing";
import seoRoutes from "./routes/seo";
import versionRoutes from "./routes/version";
import { platformStatus } from "./routes/platform-status";
import insightRoutes from "./routes/insights";
import dashboardRoutes from "./routes/dashboard";
import legalRoutes from "./routes/legal";
import importRoutes from "./routes/import";
import importBulkRoutes from "./routes/import-bulk";
import migrationRoutes from "./routes/migrations";
import specsRoutes from "./routes/specs";
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
import advisoriesRoutes from "./routes/advisories";
import aiChangelogRoutes from "./routes/ai-changelog";
import aiExplainRoutes from "./routes/ai-explain";
import aiTestsRoutes from "./routes/ai-tests";
import askRoutes from "./routes/ask";
import billingRoutes from "./routes/billing";
import stripeWebhookRoutes from "./routes/stripe-webhook";
import codeScanningRoutes from "./routes/code-scanning";
import commitStatusesRoutes from "./routes/commit-statuses";
import copilotRoutes from "./routes/copilot";
import depUpdaterRoutes from "./routes/dep-updater";
import depsRoutes from "./routes/deps";
import discussionsRoutes from "./routes/discussions";
import environmentsRoutes from "./routes/environments";
import followsRoutes from "./routes/follows";
import gatesRoutes from "./routes/gates";
import gistsRoutes from "./routes/gists";
import graphqlRoutes from "./routes/graphql";
import mcpRoutes from "./routes/mcp";
import marketplaceRoutes from "./routes/marketplace";
import mergeQueueRoutes from "./routes/merge-queue";
import mirrorsRoutes from "./routes/mirrors";
import orgInsightsRoutes from "./routes/org-insights";
import packagesRoutes from "./routes/packages";
import packagesApiRoutes from "./routes/packages-api";
import pagesRoutes from "./routes/pages";
import projectsRoutes from "./routes/projects";
import protectedTagsRoutes from "./routes/protected-tags";
import pwaRoutes from "./routes/pwa";
import releasesRoutes from "./routes/releases";
import requiredChecksRoutes from "./routes/required-checks";
import rulesetsRoutes from "./routes/rulesets";
import searchRoutes from "./routes/search";
import semanticSearchRoutes from "./routes/semantic-search";
import signingKeysRoutes from "./routes/signing-keys";
import sponsorsRoutes from "./routes/sponsors";
import ssoRoutes from "./routes/sso";
import symbolsRoutes from "./routes/symbols";
import templatesRoutes from "./routes/templates";
import trafficRoutes from "./routes/traffic";
import wikisRoutes from "./routes/wikis";
import workflowsRoutes from "./routes/workflows";
import workflowArtifactsRoutes from "./routes/workflow-artifacts";
import workflowSecretsRoutes from "./routes/workflow-secrets";
import { authRateLimit, gitRateLimit, searchRateLimit } from "./middleware/rate-limit";
import { csrfToken, csrfProtect } from "./middleware/csrf";

const app = new Hono();

// Request context (request ID, start time) runs before everything else
app.use("*", requestContext);
// Middleware — compression first (wraps all responses)
app.use("*", compress());
// Logger only on non-git routes to avoid overhead on clone/push
app.use("*", async (c, next) => {
  if (c.req.path.includes(".git/")) return next();
  return logger()(c, next);
});
app.use("/api/*", cors());
// Rate-limit API + auth endpoints (generous default)
app.use("/api/*", rateLimit(120, 60_000, "api"));
app.use("/login", rateLimit(20, 60_000, "login"));
app.use("/register", rateLimit(10, 60_000, "register"));

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

// Git Smart HTTP protocol routes (must be before web routes)
app.route("/", gitRoutes);

// REST API v1 (legacy)
app.route("/", apiRoutes);

// REST API v2 (basePath /api/v2)
app.route("/", apiV2Routes);

// Inbound API hooks (GateTest callback + backup PAT-authed /api/v1/gate-runs)
app.route("/", hookRoutes);
app.route("/api/events", eventsRoutes);

// API documentation
app.route("/", apiDocsRoutes);

// Auth routes (register, login, logout)
app.route("/", authRoutes);

// Settings routes (profile, SSH keys)
app.route("/", settingsRoutes);

// 2FA / TOTP settings (Block B4)
app.route("/", settings2faRoutes);

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

// Webhooks management
app.route("/", webhookRoutes);

// Compare view (branch diffs)
app.route("/", compareRoutes);

// Issue tracker
app.route("/", issueRoutes);

// Pull requests
app.route("/", pullRoutes);

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

// Public /status — human-readable platform health page
app.route("/", statusRoutes);

// /help — quickstart + API cheatsheet
app.route("/", helpRoutes);

// /pricing, /features, /about — marketing surface
app.route("/", marketingRoutes);

// SEO: robots.txt + sitemap.xml
app.route("/", seoRoutes);

// /api/version — live build SHA + uptime; client poller uses this to
// surface 'New version available — reload' banners on deploy.
app.route("/", versionRoutes);

// Health dashboard (per-repo health page)
app.route("/", healthDashboardRoutes);

// Insights (time-travel, dependencies, rollback)
app.route("/", insightRoutes);

// Command center dashboard
app.route("/", dashboardRoutes);

// Legal pages (terms, privacy, AUP)
app.route("/", legalRoutes);

// GitHub import / migration
app.route("/", importRoutes);
app.route("/", importBulkRoutes);
app.route("/", migrationRoutes);

// Spec-to-PR (experimental AI-generated draft PRs)
app.route("/", specsRoutes);

// Explore page
app.route("/", exploreRoutes);

// Onboarding
app.route("/", onboardingRoutes);

// Admin + feature routes
app.route("/", adminRoutes);
app.route("/", advisoriesRoutes);
app.route("/", aiChangelogRoutes);
app.route("/", aiExplainRoutes);
app.route("/", aiTestsRoutes);
app.route("/", askRoutes);
app.route("/", billingRoutes);
app.route("/", stripeWebhookRoutes);
app.route("/", codeScanningRoutes);
app.route("/", commitStatusesRoutes);
app.route("/", copilotRoutes);
app.route("/", depUpdaterRoutes);
app.route("/", depsRoutes);
app.route("/", discussionsRoutes);
app.route("/", environmentsRoutes);
app.route("/", followsRoutes);
app.route("/", gatesRoutes);
app.route("/", gistsRoutes);
app.route("/", graphqlRoutes);
app.route("/", mcpRoutes);
app.route("/", marketplaceRoutes);
app.route("/", mergeQueueRoutes);
app.route("/", mirrorsRoutes);
app.route("/", orgInsightsRoutes);
app.route("/", packagesRoutes);
app.route("/", packagesApiRoutes);
app.route("/", pagesRoutes);
app.route("/", projectsRoutes);
app.route("/", protectedTagsRoutes);
app.route("/", pwaRoutes);
app.route("/", releasesRoutes);
app.route("/", requiredChecksRoutes);
app.route("/", rulesetsRoutes);
app.route("/", searchRoutes);
app.route("/", semanticSearchRoutes);
app.route("/", signingKeysRoutes);
app.route("/", sponsorsRoutes);
app.route("/", ssoRoutes);
app.route("/", symbolsRoutes);
app.route("/", templatesRoutes);
app.route("/", trafficRoutes);
app.route("/", wikisRoutes);
app.route("/", workflowsRoutes);
app.route("/", workflowArtifactsRoutes);
app.route("/", workflowSecretsRoutes);

// Web UI (catch-all, must be last)
app.route("/", webRoutes);

// Global 404
app.notFound((c) => {
  return c.html(
    <Layout title="Not Found">
      <div class="error-page">
        <div class="error-page-code">404</div>
        <div class="eyebrow">Not found</div>
        <h1 class="display error-page-title">
          That page <span class="gradient-text">isn't here.</span>
        </h1>
        <p class="error-page-sub">
          The URL might be wrong, the resource might have moved, or you
          might not have permission to see it.
        </p>
        <div class="error-page-actions">
          <a href="/" class="btn btn-primary btn-lg">Go home</a>
          <a href="/explore" class="btn btn-ghost btn-lg">Explore repos</a>
        </div>
        <div class="error-page-meta">
          <span class="meta-mono">{c.req.method} {c.req.path}</span>
        </div>
      </div>
    </Layout>,
    404
  );
});

// Global error handler
app.onError((err, c) => {
  reportError(err, {
    requestId: c.get("requestId"),
    path: c.req.path,
    method: c.req.method,
  });
  const requestId = c.get("requestId" as never) as string | undefined;
  return c.html(
    <Layout title="Error">
      <div class="error-page">
        <div class="error-page-code error-page-code-err">500</div>
        <div class="eyebrow" style="color:var(--red)">Server error</div>
        <h1 class="display error-page-title">
          Something <span class="gradient-text">went wrong.</span>
        </h1>
        <p class="error-page-sub">
          The error has been reported. Try again — if it persists, file
          an issue with the request ID below.
        </p>
        <div class="error-page-actions">
          <a href={c.req.path} class="btn btn-primary btn-lg">Retry</a>
          <a href="/" class="btn btn-ghost btn-lg">Go home</a>
        </div>
        {requestId && (
          <div class="error-page-meta">
            <span class="meta-mono">request-id: {requestId}</span>
          </div>
        )}
        {process.env.NODE_ENV !== "production" && (
          <pre class="error-page-trace">{err.message}</pre>
        )}
      </div>
    </Layout>,
    500
  );
});

export default app;
