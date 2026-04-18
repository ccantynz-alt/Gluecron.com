import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { Layout } from "./views/layout";
import gitRoutes from "./routes/git";
import apiRoutes from "./routes/api";
import apiV2Routes from "./routes/api-v2";
import apiDocsRoutes from "./routes/api-docs";
import authRoutes from "./routes/auth";
import settingsRoutes from "./routes/settings";
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
import orgRoutes from "./routes/orgs";
import onboardingRoutes from "./routes/onboarding";
import webRoutes from "./routes/web";
import { authRateLimit, gitRateLimit, searchRateLimit } from "./middleware/rate-limit";
import { csrfToken, csrfProtect } from "./middleware/csrf";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("/api/*", cors());

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

// REST API v2 (comprehensive, token-authenticated)
app.route("/", apiV2Routes);

// API documentation
app.route("/", apiDocsRoutes);

// Auth routes (register, login, logout)
app.route("/", authRoutes);

// Settings routes (profile, SSH keys)
app.route("/", settingsRoutes);

// API tokens
app.route("/", tokenRoutes);

// Notifications
app.route("/", notificationRoutes);

// Organizations
app.route("/", orgRoutes);

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

// Explore page
app.route("/", exploreRoutes);

// Onboarding
app.route("/", onboardingRoutes);

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
