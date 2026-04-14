/**
 * Auth routes — register, login, logout (web + API).
 */

import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, sessions } from "../db/schema";
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  sessionCookieOptions,
  sessionExpiry,
} from "../lib/auth";
import { Layout } from "../views/layout";
import type { AuthEnv } from "../middleware/auth";

const auth = new Hono<AuthEnv>();

// --- Web UI ---

auth.get("/register", (c) => {
  const error = c.req.query("error");
  return c.html(
    <Layout title="Register">
      <div class="auth-container">
        <h2>Create account</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        <form method="post" action="/register">
          <div class="form-group">
            <label for="username">Username</label>
            <input
              type="text"
              id="username"
              name="username"
              required
              pattern="^[a-zA-Z0-9_-]+$"
              minLength={2}
              maxLength={39}
              placeholder="your-username"
              autocomplete="username"
            />
          </div>
          <div class="form-group">
            <label for="email">Email</label>
            <input
              type="email"
              id="email"
              name="email"
              required
              placeholder="you@example.com"
              autocomplete="email"
            />
          </div>
          <div class="form-group">
            <label for="password">Password</label>
            <input
              type="password"
              id="password"
              name="password"
              required
              minLength={8}
              placeholder="Min 8 characters"
              autocomplete="new-password"
            />
          </div>
          <button type="submit" class="btn btn-primary">
            Create account
          </button>
        </form>
        <p class="auth-switch">
          Already have an account? <a href="/login">Sign in</a>
        </p>
      </div>
    </Layout>
  );
});

auth.post("/register", async (c) => {
  const body = await c.req.parseBody();
  const username = String(body.username || "").trim();
  const email = String(body.email || "").trim();
  const password = String(body.password || "");

  if (!username || !email || !password) {
    return c.redirect("/register?error=All+fields+are+required");
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return c.redirect(
      "/register?error=Username+may+only+contain+letters%2C+numbers%2C+hyphens+and+underscores"
    );
  }

  if (password.length < 8) {
    return c.redirect("/register?error=Password+must+be+at+least+8+characters");
  }

  // Check existing
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (existingUser) {
    return c.redirect("/register?error=Username+already+taken");
  }

  const [existingEmail] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existingEmail) {
    return c.redirect("/register?error=Email+already+registered");
  }

  const passwordHash = await hashPassword(password);

  const [user] = await db
    .insert(users)
    .values({ username, email, passwordHash })
    .returning();

  // Create session
  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId: user.id,
    token,
    expiresAt: sessionExpiry(),
  });

  setCookie(c, "session", token, sessionCookieOptions());

  const redirect = c.req.query("redirect") || "/";
  return c.redirect(redirect);
});

auth.get("/login", (c) => {
  const error = c.req.query("error");
  const redirect = c.req.query("redirect") || "";
  return c.html(
    <Layout title="Sign in">
      <div class="auth-container">
        <h2>Sign in</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        <form
          method="post"
          action={`/login${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ""}`}
        >
          <div class="form-group">
            <label for="username">Username or email</label>
            <input
              type="text"
              id="username"
              name="username"
              required
              placeholder="username or email"
              autocomplete="username"
            />
          </div>
          <div class="form-group">
            <label for="password">Password</label>
            <input
              type="password"
              id="password"
              name="password"
              required
              placeholder="Password"
              autocomplete="current-password"
            />
          </div>
          <button type="submit" class="btn btn-primary">
            Sign in
          </button>
        </form>
        <p class="auth-switch">
          New to gluecron? <a href="/register">Create an account</a>
        </p>
      </div>
    </Layout>
  );
});

auth.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const identifier = String(body.username || "").trim();
  const password = String(body.password || "");
  const redirect = c.req.query("redirect") || "/";

  if (!identifier || !password) {
    return c.redirect("/login?error=All+fields+are+required");
  }

  // Find user by username or email
  const isEmail = identifier.includes("@");
  const [user] = await db
    .select()
    .from(users)
    .where(
      isEmail
        ? eq(users.email, identifier)
        : eq(users.username, identifier)
    )
    .limit(1);

  if (!user) {
    return c.redirect("/login?error=Invalid+credentials");
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return c.redirect("/login?error=Invalid+credentials");
  }

  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId: user.id,
    token,
    expiresAt: sessionExpiry(),
  });

  setCookie(c, "session", token, sessionCookieOptions());
  return c.redirect(redirect);
});

auth.get("/logout", async (c) => {
  deleteCookie(c, "session", { path: "/" });
  return c.redirect("/");
});

// --- API ---

auth.post("/api/auth/register", async (c) => {
  const body = await c.req.json<{
    username: string;
    email: string;
    password: string;
  }>();

  if (!body.username || !body.email || !body.password) {
    return c.json({ error: "username, email, and password are required" }, 400);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(body.username)) {
    return c.json({ error: "Invalid username" }, 400);
  }

  if (body.password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }

  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, body.username))
    .limit(1);
  if (existing) {
    return c.json({ error: "Username already taken" }, 409);
  }

  const passwordHash = await hashPassword(body.password);
  const [user] = await db
    .insert(users)
    .values({
      username: body.username,
      email: body.email,
      passwordHash,
    })
    .returning();

  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId: user.id,
    token,
    expiresAt: sessionExpiry(),
  });

  return c.json(
    {
      user: { id: user.id, username: user.username, email: user.email },
      token,
    },
    201
  );
});

auth.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();

  if (!body.username || !body.password) {
    return c.json({ error: "username and password are required" }, 400);
  }

  const isEmail = body.username.includes("@");
  const [user] = await db
    .select()
    .from(users)
    .where(
      isEmail
        ? eq(users.email, body.username)
        : eq(users.username, body.username)
    )
    .limit(1);

  if (!user) return c.json({ error: "Invalid credentials" }, 401);

  const valid = await verifyPassword(body.password, user.passwordHash);
  if (!valid) return c.json({ error: "Invalid credentials" }, 401);

  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId: user.id,
    token,
    expiresAt: sessionExpiry(),
  });

  return c.json({
    user: { id: user.id, username: user.username, email: user.email },
    token,
  });
});

export default auth;
