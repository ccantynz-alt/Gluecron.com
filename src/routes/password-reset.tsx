/**
 * Block P1 — Password reset routes.
 *
 * GET  /forgot-password         → email-entry form
 * POST /forgot-password         → always redirects to ?sent=1
 * GET  /reset-password?token=…  → new-password form (or invalid-link page)
 * POST /reset-password          → rotate password + redirect to /login
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { Form, FormGroup, Input, Button, Alert, Text } from "../views/ui";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  createPasswordResetRequest,
  consumeResetToken,
  inspectResetToken,
} from "../lib/password-reset";

const passwordReset = new Hono<AuthEnv>();

passwordReset.get("/forgot-password", softAuth, (c) => {
  const csrf = c.get("csrfToken") as string | undefined;
  const sent = c.req.query("sent") === "1";

  if (sent) {
    return c.html(
      <Layout title="Reset link sent" user={c.get("user") ?? null}>
        <div class="auth-container">
          <h2>Check your inbox</h2>
          <Alert variant="success">
            If we have an account for that email, we've sent a reset link.
            Check your inbox (and spam folder).
          </Alert>
          <p class="auth-switch"><Text>The link expires in 1 hour.</Text></p>
          <p class="auth-switch"><a href="/login">Back to sign in</a></p>
        </div>
      </Layout>
    );
  }

  return c.html(
    <Layout title="Forgot password" user={c.get("user") ?? null}>
      <div class="auth-container">
        <h2>Reset your password</h2>
        <p class="auth-switch" style="margin-bottom:16px;margin-top:0">
          <Text>Enter the email tied to your account and we'll send you a link to set a new password.</Text>
        </p>
        <Form method="post" action="/forgot-password" csrfToken={csrf}>
          <FormGroup label="Email" htmlFor="email">
            <Input type="email" name="email" required placeholder="you@example.com" autocomplete="email" aria-label="Email" />
          </FormGroup>
          <Button type="submit" variant="primary">Send reset link</Button>
        </Form>
        <p class="auth-switch"><Text>Remembered it? <a href="/login">Sign in</a></Text></p>
      </div>
    </Layout>
  );
});

passwordReset.post("/forgot-password", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email || "").trim();
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    undefined;
  await createPasswordResetRequest(email, { requestIp: ip });
  return c.redirect("/forgot-password?sent=1");
});

function InvalidLinkPage(props: { user: any }) {
  return (
    <Layout title="Link no longer valid" user={props.user ?? null}>
      <div class="auth-container">
        <h2>This link is no longer valid</h2>
        <Alert variant="error">
          Reset links expire after 1 hour and can only be used once. This link is expired, already used, or unknown.
        </Alert>
        <p class="auth-switch" style="margin-top:16px"><a href="/forgot-password">Request a new one</a></p>
        <p class="auth-switch"><a href="/login">Back to sign in</a></p>
      </div>
    </Layout>
  );
}

passwordReset.get("/reset-password", softAuth, async (c) => {
  const token = String(c.req.query("token") || "").trim();
  const csrf = c.get("csrfToken") as string | undefined;
  const error = c.req.query("error");

  if (!token) return c.html(<InvalidLinkPage user={c.get("user")} />);
  const check = await inspectResetToken(token);
  if (!check.valid) return c.html(<InvalidLinkPage user={c.get("user")} />);

  return c.html(
    <Layout title="Set a new password" user={c.get("user") ?? null}>
      <div class="auth-container">
        <h2>Set a new password</h2>
        {error && <Alert variant="error">{decodeURIComponent(error)}</Alert>}
        <p class="auth-switch" style="margin-bottom:16px;margin-top:0">
          <Text>Choose a new password — at least 8 characters. Signing in from other devices will be required afterwards.</Text>
        </p>
        <Form method="post" action="/reset-password" csrfToken={csrf}>
          <input type="hidden" name="token" value={token} />
          <FormGroup label="New password" htmlFor="password">
            <Input type="password" name="password" required minLength={8} placeholder="Min 8 characters" autocomplete="new-password" aria-label="New password" />
          </FormGroup>
          <FormGroup label="Confirm new password" htmlFor="confirm">
            <Input type="password" name="confirm" required minLength={8} placeholder="Re-enter the new password" autocomplete="new-password" aria-label="Confirm new password" />
          </FormGroup>
          <Button type="submit" variant="primary">Update password</Button>
        </Form>
        <p class="auth-switch"><a href="/login">Cancel</a></p>
      </div>
    </Layout>
  );
});

passwordReset.post("/reset-password", async (c) => {
  const body = await c.req.parseBody();
  const token = String(body.token || "").trim();
  const password = String(body.password || "");
  const confirm = String(body.confirm || "");

  const back = (msg: string) =>
    c.redirect(`/reset-password?token=${encodeURIComponent(token)}&error=${encodeURIComponent(msg)}`);

  if (!token) return c.html(<InvalidLinkPage user={null} />);
  if (!password || password.length < 8) return back("Password must be at least 8 characters");
  if (password !== confirm) return back("Passwords do not match");

  const result = await consumeResetToken(token, password);
  if (!result.ok) {
    if (result.reason === "weak") return back("Password must be at least 8 characters");
    return c.html(<InvalidLinkPage user={null} />);
  }

  return c.redirect("/login?success=" + encodeURIComponent("Password updated — please sign in"));
});

export default passwordReset;
