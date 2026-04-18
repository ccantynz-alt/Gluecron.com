/**
 * User settings routes — profile, SSH keys.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, sshKeys } from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";
import { raw } from "hono/html";
import { composeDigest } from "../lib/email-digest";
import {
  Alert,
  Button,
  Flex,
  Form,
  FormGroup,
  Input,
  PageHeader,
  Section,
  Text,
  TextArea,
} from "../views/ui";

const settings = new Hono<AuthEnv>();

// Auth guard scoped to /settings paths only
settings.use("/settings/*", requireAuth);
settings.use("/settings", requireAuth);
settings.use("/api/user/*", requireAuth);

// Profile settings
settings.get("/settings", (c) => {
  const user = c.get("user")!;
  const success = c.req.query("success");
  return c.html(
    <Layout title="Settings">
      <div class="settings-container">
        <PageHeader title="Profile settings" />
        {success && (
          <Alert variant="success">
            {decodeURIComponent(success)}
          </Alert>
        )}
        <Form method="post" action="/settings/profile">
          <FormGroup label="Username" htmlFor="username">
            <Input
              name="username"
              id="username"
              type="text"
              value={user.username}
              disabled
            />
          </FormGroup>
          <FormGroup label="Display name" htmlFor="display_name">
            <Input
              name="display_name"
              id="display_name"
              value={user.displayName || ""}
              placeholder="Your display name"
            />
          </FormGroup>
          <FormGroup label="Bio" htmlFor="bio">
            <TextArea
              name="bio"
              id="bio"
              rows={3}
              placeholder="Tell us about yourself"
              value={user.bio || ""}
            />
          </FormGroup>
          <FormGroup label="Email" htmlFor="email">
            <Input
              name="email"
              id="email"
              type="email"
              value={user.email}
              required
            />
          </FormGroup>
          <Button type="submit" variant="primary">
            Update profile
          </Button>
        </Form>

        <h3 style="margin-top: 32px; font-size: 16px">Email notifications</h3>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 12px">
          Opt out of individual email categories. In-app notifications are
          unaffected and continue to appear in your inbox.
        </p>
        <form method="post" action="/settings/notifications">
          <label
            style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px; font-size: 14px"
          >
            <input
              type="checkbox"
              name="notify_email_on_mention"
              value="1"
              checked={user.notifyEmailOnMention}
            />
            <span>
              Someone <code>@mentions</code> me or requests a review
            </span>
          </label>
          <label
            style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px; font-size: 14px"
          >
            <input
              type="checkbox"
              name="notify_email_on_assign"
              value="1"
              checked={user.notifyEmailOnAssign}
            />
            <span>I am assigned to an issue or PR</span>
          </label>
          <label
            style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px; font-size: 14px"
          >
            <input
              type="checkbox"
              name="notify_email_on_gate_fail"
              value="1"
              checked={user.notifyEmailOnGateFail}
            />
            <span>A gate fails on one of my repositories</span>
          </label>
          <label
            style="display: flex; gap: 8px; align-items: center; margin-bottom: 12px; font-size: 14px"
          >
            <input
              type="checkbox"
              name="notify_email_digest_weekly"
              value="1"
              checked={user.notifyEmailDigestWeekly}
            />
            <span>
              Weekly digest &mdash;{" "}
              <a href="/settings/digest/preview">preview</a>
            </span>
          </label>
          <button type="submit" class="btn btn-primary">
            Save preferences
          </button>
        </form>
      </div>
    </Layout>
  );
});

// Preview the weekly digest in-browser (rendered HTML)
settings.get("/settings/digest/preview", async (c) => {
  const user = c.get("user")!;
  const body = await composeDigest(user.id);
  if (!body) {
    return c.html(
      <Layout title="Digest preview" user={user}>
        <h2>Digest preview</h2>
        <p>Could not compose a digest right now.</p>
        <p>
          <a href="/settings">Back to settings</a>
        </p>
      </Layout>
    );
  }
  return c.html(
    <Layout title="Digest preview" user={user}>
      <h2>Digest preview</h2>
      <p style="color:var(--text-muted);font-size:13px">
        Subject: <code>{body.subject}</code>
      </p>
      <p style="font-size:12px;color:var(--text-muted)">
        Notifications: {body.counts.notifications} · Failed gates:{" "}
        {body.counts.failedGates} · Repaired: {body.counts.repairedGates} ·
        Merged PRs: {body.counts.mergedPrs}
      </p>
      <div
        class="panel"
        style="padding:20px;background:#fff;color:#111"
      >
        {raw(body.html)}
      </div>
      <p style="margin-top:20px">
        <a href="/settings">Back to settings</a>
      </p>
    </Layout>
  );
});

settings.post("/settings/notifications", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  await db
    .update(users)
    .set({
      notifyEmailOnMention: String(body.notify_email_on_mention || "") === "1",
      notifyEmailOnAssign: String(body.notify_email_on_assign || "") === "1",
      notifyEmailOnGateFail:
        String(body.notify_email_on_gate_fail || "") === "1",
      notifyEmailDigestWeekly:
        String(body.notify_email_digest_weekly || "") === "1",
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));
  return c.redirect("/settings?success=Email+preferences+updated");
});

settings.post("/settings/profile", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();

  await db
    .update(users)
    .set({
      displayName: String(body.display_name || "").trim() || null,
      bio: String(body.bio || "").trim() || null,
      email: String(body.email || "").trim() || user.email,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return c.redirect("/settings?success=Profile+updated");
});

// SSH Keys page
settings.get("/settings/keys", async (c) => {
  const user = c.get("user")!;
  const success = c.req.query("success");
  const error = c.req.query("error");

  const keys = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.userId, user.id));

  return c.html(
    <Layout title="SSH Keys">
      <div class="settings-container">
        <PageHeader title="SSH Keys" />
        {success && (
          <Alert variant="success">{decodeURIComponent(success)}</Alert>
        )}
        {error && (
          <Alert variant="error">{decodeURIComponent(error)}</Alert>
        )}
        <div class="ssh-keys-list">
          {keys.length === 0 ? (
            <Text muted>
              No SSH keys yet. Add one below.
            </Text>
          ) : (
            keys.map((key) => (
              <div class="ssh-key-item">
                <div>
                  <strong>{key.title}</strong>
                  <div class="ssh-key-meta">
                    <code>{key.fingerprint}</code>
                    <span>
                      Added{" "}
                      {new Date(key.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                    {key.lastUsedAt && (
                      <span>
                        — Last used{" "}
                        {new Date(key.lastUsedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
                <form method="post" action={`/settings/keys/${key.id}/delete`}>
                  <button type="submit" class="btn btn-danger btn-sm">
                    Delete
                  </button>
                </form>
              </div>
            ))
          )}
        </div>

        <h3 style="margin-top: 24px">Add new SSH key</h3>
        <form method="post" action="/settings/keys">
          <div class="form-group">
            <label for="title">Title</label>
            <input
              type="text"
              id="title"
              name="title"
              required
              placeholder="e.g. My laptop"
            />
          </div>
          <div class="form-group">
            <label for="public_key">Public key</label>
            <textarea
              id="public_key"
              name="public_key"
              rows={4}
              required
              placeholder="ssh-ed25519 AAAA... or ssh-rsa AAAA..."
              style="font-family: var(--font-mono); font-size: 12px"
            />
          </div>
          <button type="submit" class="btn btn-primary">
            Add SSH key
          </button>
        </form>
      </div>
    </Layout>
  );
});

settings.post("/settings/keys", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const title = String(body.title || "").trim();
  const publicKey = String(body.public_key || "").trim();

  if (!title || !publicKey) {
    return c.redirect("/settings/keys?error=Title+and+key+are+required");
  }

  // Basic validation
  if (
    !publicKey.startsWith("ssh-rsa ") &&
    !publicKey.startsWith("ssh-ed25519 ") &&
    !publicKey.startsWith("ecdsa-sha2-")
  ) {
    return c.redirect("/settings/keys?error=Invalid+SSH+public+key+format");
  }

  // Generate a simple fingerprint (hash of key data)
  const keyData = publicKey.split(" ")[1] || "";
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(keyData)
  );
  const fingerprint =
    "SHA256:" +
    btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
      .replace(/=+$/, "");

  await db.insert(sshKeys).values({
    userId: user.id,
    title,
    fingerprint,
    publicKey,
  });

  return c.redirect("/settings/keys?success=SSH+key+added");
});

settings.post("/settings/keys/:id/delete", async (c) => {
  const user = c.get("user")!;
  const keyId = c.req.param("id");

  // Verify ownership
  const [key] = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.id, keyId))
    .limit(1);

  if (!key || key.userId !== user.id) {
    return c.redirect("/settings/keys?error=Key+not+found");
  }

  await db.delete(sshKeys).where(eq(sshKeys.id, keyId));
  return c.redirect("/settings/keys?success=SSH+key+deleted");
});

// SSH Keys API
settings.get("/api/user/keys", async (c) => {
  const user = c.get("user")!;
  const keys = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.userId, user.id));
  return c.json(keys);
});

settings.post("/api/user/keys", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ title: string; public_key: string }>();

  if (!body.title || !body.public_key) {
    return c.json({ error: "title and public_key are required" }, 400);
  }

  const keyData = body.public_key.split(" ")[1] || "";
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(keyData)
  );
  const fingerprint =
    "SHA256:" +
    btoa(String.fromCharCode(...new Uint8Array(hashBuffer))).replace(/=+$/, "");

  const [key] = await db
    .insert(sshKeys)
    .values({
      userId: user.id,
      title: body.title,
      fingerprint,
      publicKey: body.public_key,
    })
    .returning();

  return c.json(key, 201);
});

settings.delete("/api/user/keys/:id", async (c) => {
  const user = c.get("user")!;
  const keyId = c.req.param("id");

  const [key] = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.id, keyId))
    .limit(1);

  if (!key || key.userId !== user.id) {
    return c.json({ error: "Key not found" }, 404);
  }

  await db.delete(sshKeys).where(eq(sshKeys.id, keyId));
  return c.json({ deleted: true });
});

export default settings;
