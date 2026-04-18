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
        <Form action="/settings/profile" method="post">
          <FormGroup label="Username" htmlFor="username">
            <Input
              name="username"
              id="username"
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
                <Form action={`/settings/keys/${key.id}/delete`} method="post">
                  <Button type="submit" variant="danger" size="sm">
                    Delete
                  </Button>
                </Form>
              </div>
            ))
          )}
        </div>

        <Section title="Add new SSH key" style="margin-top:24px">
          <Form action="/settings/keys" method="post">
            <FormGroup label="Title" htmlFor="title">
              <Input
                name="title"
                id="title"
                required
                placeholder="e.g. My laptop"
              />
            </FormGroup>
            <FormGroup label="Public key" htmlFor="public_key">
              <TextArea
                name="public_key"
                id="public_key"
                rows={4}
                required
                placeholder="ssh-ed25519 AAAA... or ssh-rsa AAAA..."
                mono
              />
            </FormGroup>
            <Button type="submit" variant="primary">
              Add SSH key
            </Button>
          </Form>
        </Section>
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
