import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { Layout } from "./views/layout";
import gitRoutes from "./routes/git";
import apiRoutes from "./routes/api";
import authRoutes from "./routes/auth";
import settingsRoutes from "./routes/settings";
import issueRoutes from "./routes/issues";
import repoSettings from "./routes/repo-settings";
import compareRoutes from "./routes/compare";
import pullRoutes from "./routes/pulls";
import editorRoutes from "./routes/editor";
import webRoutes from "./routes/web";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("/api/*", cors());

// Git Smart HTTP protocol routes (must be before web routes)
app.route("/", gitRoutes);

// REST API
app.route("/", apiRoutes);

// Auth routes (register, login, logout)
app.route("/", authRoutes);

// Settings routes (profile, SSH keys)
app.route("/", settingsRoutes);

// Repo settings (description, visibility, delete)
app.route("/", repoSettings);

// Compare view (branch diffs)
app.route("/", compareRoutes);

// Issue tracker
app.route("/", issueRoutes);

// Pull requests
app.route("/", pullRoutes);

// Web file editor
app.route("/", editorRoutes);

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
