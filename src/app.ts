import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import gitRoutes from "./routes/git";
import apiRoutes from "./routes/api";
import authRoutes from "./routes/auth";
import settingsRoutes from "./routes/settings";
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

// Settings routes (profile, SSH keys) — requires auth
app.route("/", settingsRoutes);

// Web UI (catch-all, must be last)
app.route("/", webRoutes);

export default app;
