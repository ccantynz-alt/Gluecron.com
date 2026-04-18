/**
 * Webhooks management — register, list, delete, test.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { webhooks, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  Container,
  Flex,
  Form,
  FormGroup,
  Input,
  Button,
  Alert,
} from "../views/ui";

const webhookRoutes = new Hono<AuthEnv>();

webhookRoutes.use("*", softAuth);

// List webhooks
webhookRoutes.get(
  "/:owner/:repo/settings/webhooks",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const success = c.req.query("success");
    const error = c.req.query("error");

    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.text("Unauthorized", 403);
    }

    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return c.notFound();

    const hooks = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.repositoryId, repo.id));

    return c.html(
      <Layout title={`Webhooks — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <Container maxWidth={700}>
          <h2 style="margin-bottom: 16px">Webhooks</h2>
          {success && (
            <Alert variant="success">{decodeURIComponent(success)}</Alert>
          )}
          {error && (
            <Alert variant="error">{decodeURIComponent(error)}</Alert>
          )}
          {hooks.length > 0 && (
            <div style="margin-bottom: 24px">
              {hooks.map((hook) => (
                <div class="ssh-key-item">
                  <div>
                    <strong>{hook.url}</strong>
                    <div class="ssh-key-meta">
                      Events: {hook.events} |{" "}
                      {hook.isActive ? (
                        <span style="color: var(--green)">Active</span>
                      ) : (
                        <span style="color: var(--red)">Inactive</span>
                      )}
                      {hook.lastDeliveredAt && (
                        <span>
                          {" "}
                          | Last: {hook.lastStatus}
                        </span>
                      )}
                    </div>
                  </div>
                  <form
                    method="post"
                    action={`/${ownerName}/${repoName}/settings/webhooks/${hook.id}/delete`}
                  >
                    <Button type="submit" variant="danger" size="sm">
                      Delete
                    </Button>
                  </Form>
                </div>
              ))}
            </div>
          )}

          <h3 style="margin-bottom: 12px">Add webhook</h3>
          <form
            method="post"
            action={`/${ownerName}/${repoName}/settings/webhooks`}
          >
            <FormGroup label="Payload URL">
              <Input
                type="url"
                name="url"
                required
                placeholder="https://example.com/hooks/gluecron"
              />
            </FormGroup>
            <FormGroup label="Secret (optional)">
              <Input
                type="text"
                name="secret"
                placeholder="Shared secret for HMAC verification"
              />
            </FormGroup>
            <FormGroup label="Events">
              <Flex gap={16} wrap>
                {["push", "issue", "pr", "star"].map((evt) => (
                  <label style="display: flex; align-items: center; gap: 4px; font-size: 14px; cursor: pointer">
                    <input
                      type="checkbox"
                      name="events"
                      value={evt}
                      checked={evt === "push"}
                    />{" "}
                    {evt}
                  </label>
                ))}
              </Flex>
            </FormGroup>
            <Button type="submit" variant="primary">
              Add webhook
            </Button>
          </Form>
        </Container>
      </Layout>
    );
  }
);

// Create webhook
webhookRoutes.post(
  "/:owner/:repo/settings/webhooks",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const url = String(body.url || "").trim();
    const secret = String(body.secret || "").trim() || null;

    // Events can be a string or array
    let events: string;
    const rawEvents = body.events;
    if (Array.isArray(rawEvents)) {
      events = rawEvents.join(",");
    } else {
      events = String(rawEvents || "push");
    }

    if (!url) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings/webhooks?error=URL+is+required`
      );
    }

    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }

    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return c.redirect(`/${ownerName}/${repoName}`);

    await db.insert(webhooks).values({
      repositoryId: repo.id,
      url,
      secret,
      events,
    });

    return c.redirect(
      `/${ownerName}/${repoName}/settings/webhooks?success=Webhook+added`
    );
  }
);

// Delete webhook
webhookRoutes.post(
  "/:owner/:repo/settings/webhooks/:id/delete",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, id } = c.req.param();

    await db.delete(webhooks).where(eq(webhooks.id, id));

    return c.redirect(
      `/${ownerName}/${repoName}/settings/webhooks?success=Webhook+deleted`
    );
  }
);

export default webhookRoutes;

/**
 * Fire webhooks for a repository event.
 */
export async function fireWebhooks(
  repositoryId: string,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const hooks = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.repositoryId, repositoryId));

    for (const hook of hooks) {
      if (!hook.isActive) continue;
      const hookEvents = hook.events.split(",");
      if (!hookEvents.includes(event)) continue;

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "X-Gluecron-Event": event,
        };

        if (hook.secret) {
          const encoder = new TextEncoder();
          const key = await crypto.subtle.importKey(
            "raw",
            encoder.encode(hook.secret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
          );
          const signature = await crypto.subtle.sign(
            "HMAC",
            key,
            encoder.encode(JSON.stringify(payload))
          );
          headers["X-Gluecron-Signature"] =
            "sha256=" +
            Array.from(new Uint8Array(signature))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
        }

        const res = await fetch(hook.url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });

        await db
          .update(webhooks)
          .set({
            lastDeliveredAt: new Date(),
            lastStatus: res.status,
          })
          .where(eq(webhooks.id, hook.id));
      } catch (err) {
        console.error(`[webhook] delivery failed for ${hook.url}:`, err);
        await db
          .update(webhooks)
          .set({
            lastDeliveredAt: new Date(),
            lastStatus: 0,
          })
          .where(eq(webhooks.id, hook.id));
      }
    }
  } catch (err) {
    console.error("[webhook] failed to query webhooks:", err);
  }
}
