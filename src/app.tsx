import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { Layout } from "./views/layout";
import { requestContext } from "./middleware/request-context";
import { rateLimit } from "./middleware/rate-limit";
import gitRoutes from "./routes/git";
import apiRoutes from "./routes/api";
import authRoutes from "./routes/auth";
import settingsRoutes from "./routes/settings";
import settings2faRoutes from "./routes/settings-2fa";
import issueRoutes from "./routes/issues";
import repoSettings from "./routes/repo-settings";
import compareRoutes from "./routes/compare";
import pullRoutes from "./routes/pulls";
import editorRoutes from "./routes/editor";
import forkRoutes from "./routes/fork";
import webhookRoutes from "./routes/webhooks";
import exploreRoutes from "./routes/explore";
import tokenRoutes from "./routes/tokens";
import contributorRoutes from "./routes/contributors";
import notificationRoutes from "./routes/notifications";
import dashboardRoutes from "./routes/dashboard";
import askRoutes from "./routes/ask";
import releaseRoutes from "./routes/releases";
import gateRoutes from "./routes/gates";
import insightsRoutes from "./routes/insights";
import searchRoutes from "./routes/search";
import healthRoutes from "./routes/health";
import hookRoutes from "./routes/hooks";
import themeRoutes from "./routes/theme";
import auditRoutes from "./routes/audit";
import reactionRoutes from "./routes/reactions";
import savedReplyRoutes from "./routes/saved-replies";
import deploymentRoutes from "./routes/deployments";
import orgRoutes from "./routes/orgs";
import passkeyRoutes from "./routes/passkeys";
import oauthRoutes from "./routes/oauth";
import developerAppsRoutes from "./routes/developer-apps";
import workflowRoutes from "./routes/workflows";
import packagesApiRoutes from "./routes/packages-api";
import packagesUiRoutes from "./routes/packages";
import pagesRoutes from "./routes/pages";
import environmentsRoutes from "./routes/environments";
import aiExplainRoutes from "./routes/ai-explain";
import aiChangelogRoutes from "./routes/ai-changelog";
import copilotRoutes from "./routes/copilot";
import depUpdaterRoutes from "./routes/dep-updater";
import semanticSearchRoutes from "./routes/semantic-search";
import aiTestsRoutes from "./routes/ai-tests";
import discussionRoutes from "./routes/discussions";
import gistRoutes from "./routes/gists";
import projectRoutes from "./routes/projects";
import wikiRoutes from "./routes/wikis";
import mergeQueueRoutes from "./routes/merge-queue";
import requiredChecksRoutes from "./routes/required-checks";
import protectedTagsRoutes from "./routes/protected-tags";
import trafficRoutes from "./routes/traffic";
import orgInsightsRoutes from "./routes/org-insights";
import adminRoutes from "./routes/admin";
import billingRoutes from "./routes/billing";
import pwaRoutes from "./routes/pwa";
import graphqlRoutes from "./routes/graphql";
import marketplaceRoutes from "./routes/marketplace";
import templatesRoutes from "./routes/templates";
import codeScanningRoutes from "./routes/code-scanning";
import sponsorsRoutes from "./routes/sponsors";
import symbolsRoutes from "./routes/symbols";
import mirrorsRoutes from "./routes/mirrors";
import ssoRoutes from "./routes/sso";
import depsRoutes from "./routes/deps";
import advisoriesRoutes from "./routes/advisories";
import signingKeysRoutes from "./routes/signing-keys";
import followsRoutes from "./routes/follows";
import rulesetsRoutes from "./routes/rulesets";
import commitStatusesRoutes from "./routes/commit-statuses";
import webRoutes from "./routes/web";

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
app.use("/api/*", rateLimit({ windowMs: 60_000, max: 120 }));
app.use("/login", rateLimit({ windowMs: 60_000, max: 20 }));
app.use("/register", rateLimit({ windowMs: 60_000, max: 10 }));

// Git Smart HTTP protocol routes (must be before web routes)
app.route("/", gitRoutes);

// Health + metrics
app.route("/", healthRoutes);

// Inbound API hooks (GateTest callback + backup PAT-authed /api/v1/gate-runs)
app.route("/", hookRoutes);

// REST API
app.route("/", apiRoutes);

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

// Notifications inbox
app.route("/", notificationRoutes);

// Dashboard (/dashboard)
app.route("/", dashboardRoutes);

// AI assistant — /ask + /:owner/:repo/ask
app.route("/", askRoutes);

// Global search
app.route("/", searchRoutes);

// Repo settings (description, visibility, delete)
app.route("/", repoSettings);

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

// Releases
app.route("/", releaseRoutes);

// Gates (history + settings + branch protection)
app.route("/", gateRoutes);

// Actions-equivalent workflow runner (Block C1)
app.route("/", workflowRoutes);

// Package registry — npm protocol + UI (Block C2)
app.route("/", packagesApiRoutes);
app.route("/", packagesUiRoutes);

// Pages / static hosting (Block C3)
app.route("/", pagesRoutes);

// Environments with protected approvals (Block C4)
app.route("/", environmentsRoutes);

// AI-native features (Block D)
app.route("/", aiExplainRoutes);      // D6 — /:owner/:repo/explain
app.route("/", aiChangelogRoutes);    // D7 — /:owner/:repo/ai/changelog
app.route("/", copilotRoutes);        // D9 — /api/copilot/completions
app.route("/", depUpdaterRoutes);     // D2 — /:owner/:repo/settings/dep-updater
app.route("/", semanticSearchRoutes); // D1 — /:owner/:repo/search/semantic
app.route("/", aiTestsRoutes);        // D8 — /:owner/:repo/ai/tests
app.route("/", discussionRoutes);     // E2 — /:owner/:repo/discussions
app.route("/", gistRoutes);           // E4 — /gists, /gists/:slug, /:user/gists
app.route("/", projectRoutes);        // E1 — /:owner/:repo/projects
app.route("/", wikiRoutes);           // E3 — /:owner/:repo/wiki
app.route("/", mergeQueueRoutes);     // E5 — /:owner/:repo/queue
app.route("/", requiredChecksRoutes); // E6 — /:owner/:repo/gates/protection/:id/checks
app.route("/", protectedTagsRoutes);  // E7 — /:owner/:repo/settings/protected-tags
app.route("/", trafficRoutes);        // F1 — /:owner/:repo/traffic
app.route("/", orgInsightsRoutes);    // F2 — /orgs/:slug/insights
app.route("/", adminRoutes);          // F3 — /admin
app.route("/", billingRoutes);        // F4 — /settings/billing + /admin/billing

// PWA — manifest + service worker + icon (Block G1)
app.route("/", pwaRoutes);

// GraphQL mirror of REST (Block G2)
app.route("/", graphqlRoutes);

// Marketplace + app installations + bot identities (Block H1 + H2)
app.route("/", marketplaceRoutes);

// Template repositories — POST /:owner/:repo/use-template (Block I2)
app.route("/", templatesRoutes);

// Code scanning UI — /:owner/:repo/security (Block I5)
app.route("/", codeScanningRoutes);

// Sponsors — /sponsors/:user + /settings/sponsors (Block I6)
app.route("/", sponsorsRoutes);

// Symbol / xref navigation — /:owner/:repo/symbols (Block I8)
app.route("/", symbolsRoutes);

// Repository mirroring — /:owner/:repo/settings/mirror (Block I9)
app.route("/", mirrorsRoutes);

// Enterprise SSO via OIDC — /admin/sso + /login/sso (Block I10)
app.route("/", ssoRoutes);

// Dependency graph — /:owner/:repo/dependencies (Block J1)
app.route("/", depsRoutes);

// Security advisories / dependabot alerts — /:owner/:repo/security/advisories (Block J2)
app.route("/", advisoriesRoutes);

// Commit signature verification / signing keys — /settings/signing-keys (Block J3)
app.route("/", signingKeysRoutes);

// User following + personalised feed (Block J4)
app.route("/", followsRoutes);

// Repository rulesets — /:owner/:repo/settings/rulesets (Block J6)
app.route("/", rulesetsRoutes);

// Commit status API — /api/v1/repos/:o/:r/statuses/:sha (Block J8)
app.route("/", commitStatusesRoutes);

// Insights + milestones
app.route("/", insightsRoutes);

// Explore page
app.route("/", exploreRoutes);

// Web UI (catch-all, must be last)
app.route("/", webRoutes);

// Global 404
app.notFound((c) => {
  return c.html(
    <Layout title="Not Found">
      <div class="empty-state">
        <h2>404</h2>
        <p>Page not found.</p>
        <a href="/" style="margin-top: 12px; display: inline-block">
          Go home
        </a>
      </div>
    </Layout>,
    404
  );
});

// Global error handler
app.onError((err, c) => {
  console.error("[error]", err);
  return c.html(
    <Layout title="Error">
      <div class="empty-state">
        <h2>Something went wrong</h2>
        <p>An unexpected error occurred.</p>
        {process.env.NODE_ENV !== "production" && (
          <pre style="margin-top: 16px; text-align: left; font-size: 12px; color: var(--red)">
            {err.message}
          </pre>
        )}
      </div>
    </Layout>,
    500
  );
});

export default app;
