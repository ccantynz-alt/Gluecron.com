import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import gitRoutes from "./routes/git";
import apiRoutes from "./routes/api";
import webRoutes from "./routes/web";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("/api/*", cors());

// Git Smart HTTP protocol routes (must be before web routes)
app.route("/", gitRoutes);

// REST API
app.route("/", apiRoutes);

// Web UI (catch-all, must be last)
app.route("/", webRoutes);

export default app;
