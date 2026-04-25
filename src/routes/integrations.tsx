/**
 * Per-repo integrations management.
 *
 * UI lives at `/:owner/:repo/settings/integrations`:
 *   - List existing connectors with status / last delivery
 *   - Add a connector (kind + name + config + events)
 *   - Toggle enable, edit, delete
 *   - "Send test" button → fires a synthetic event through the connector
 *
 * Owner-only via requireRepoAccess("admin"). Reads redact secret config
 * fields before rendering.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import {
  Container,
  Form,
  FormGroup,
  Input,
  Button,
  Alert,
  Select,
} from "../views/ui";
import {
  CONNECTORS,
  INTEGRATION_EVENTS,
  createIntegration,
  deleteIntegration,
  deliverOne,
  getById,
  getConnector,
  isValidEvent,
  isValidKind,
  listDeliveries,
  listForRepo,
  redactConfig,
  updateIntegration,
  type IntegrationEvent,
  type IntegrationKind,
} from "../lib/integrations";

const app = new Hono<AuthEnv>();

app.use("*", softAuth);

async function ownedRepo(ownerName: string, repoName: string, userId: string) {
  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!owner || owner.id !== userId) return null;
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);
  return repo ?? null;
}

app.get(
  "/:owner/:repo/settings/integrations",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const success = c.req.query("success");
    const error = c.req.query("error");

    const repo = await ownedRepo(ownerName, repoName, user.id);
    if (!repo) return c.text("Unauthorized", 403);

    const integrations = await listForRepo(repo.id);

    return c.html(
      <Layout title={`Integrations — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <Container maxWidth={760}>
          <h2 style="margin-bottom: 6px">Integrations</h2>
          <p style="color: var(--text-muted); margin-bottom: 16px">
            Forward gluecron events into Slack, Discord, Linear, Vercel, Jira,
            PagerDuty, Sentry, Datadog, and any custom webhook target.
          </p>
          {success && <Alert variant="success">{decodeURIComponent(success)}</Alert>}
          {error && <Alert variant="error">{decodeURIComponent(error)}</Alert>}

          {integrations.length === 0 && (
            <div
              style="
                background: var(--bg-secondary);
                border: 1px dashed var(--border);
                border-radius: 6px;
                padding: 16px;
                margin-bottom: 24px;
                color: var(--text-muted);
              "
            >
              No integrations yet. Add one below.
            </div>
          )}

          {integrations.map((row) => {
            const meta = getConnector(row.kind as IntegrationKind);
            const evs = Array.isArray(row.events) ? (row.events as string[]) : [];
            const config = redactConfig(
              row.kind as IntegrationKind,
              (row.config as Record<string, unknown>) ?? {}
            );
            return (
              <div
                style="
                  background: var(--bg-secondary);
                  border: 1px solid var(--border);
                  border-radius: 6px;
                  padding: 14px;
                  margin-bottom: 12px;
                "
              >
                <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                  <div>
                    <strong>{row.name}</strong>
                    <span style="margin-left:8px; padding:2px 6px; background:rgba(99,102,241,0.15); color:#a5b4fc; border-radius:4px; font-size:11px;">
                      {meta?.label ?? row.kind}
                    </span>
                    {!row.enabled && (
                      <span style="margin-left:6px; color: var(--red); font-size:11px">
                        disabled
                      </span>
                    )}
                    <div style="font-size:12px; color: var(--text-muted); margin-top:4px;">
                      Events: {evs.length > 0 ? evs.join(", ") : "(none)"}
                    </div>
                    <div style="font-size:11px; color: var(--text-muted); margin-top:4px; font-family:ui-monospace,monospace;">
                      {Object.entries(config)
                        .map(([k, v]) => `${k}=${v}`)
                        .join("  ")}
                    </div>
                    <div style="font-size:11px; color: var(--text-muted); margin-top:4px;">
                      {row.lastDeliveryAt
                        ? `last: ${new Date(row.lastDeliveryAt).toISOString()} (${row.lastStatus ?? "unknown"})`
                        : "never delivered"}
                    </div>
                  </div>
                  <div style="display:flex; gap:6px; flex-direction:column; align-items:flex-end;">
                    <form
                      method="post"
                      action={`/${ownerName}/${repoName}/settings/integrations/${row.id}/test`}
                    >
                      <Button type="submit" size="sm">Send test</Button>
                    </form>
                    <form
                      method="post"
                      action={`/${ownerName}/${repoName}/settings/integrations/${row.id}/toggle`}
                    >
                      <Button type="submit" size="sm">
                        {row.enabled ? "Disable" : "Enable"}
                      </Button>
                    </form>
                    <form
                      method="post"
                      action={`/${ownerName}/${repoName}/settings/integrations/${row.id}/delete`}
                    >
                      <Button type="submit" variant="danger" size="sm">
                        Delete
                      </Button>
                    </form>
                  </div>
                </div>
              </div>
            );
          })}

          <h3 style="margin-top: 24px; margin-bottom: 12px">Add integration</h3>
          <Form
            method="post"
            action={`/${ownerName}/${repoName}/settings/integrations`}
          >
            <FormGroup label="Connector">
              <Select name="kind">
                {CONNECTORS.map((c) => (
                  <option value={c.kind}>
                    {c.label} — {c.description}
                  </option>
                ))}
              </Select>
            </FormGroup>
            <FormGroup label="Name (free-form label)">
              <Input
                type="text"
                name="name"
                required
                placeholder="Engineering channel"
              />
            </FormGroup>
            <FormGroup label="Config (JSON)">
              <textarea
                name="config"
                rows={5}
                style="width:100%; font-family: ui-monospace, monospace; padding:8px; background: var(--bg); color: var(--text); border:1px solid var(--border); border-radius:6px"
                placeholder='{"webhookUrl": "https://hooks.slack.com/..."}'
                required
              ></textarea>
            </FormGroup>
            <FormGroup label="Events">
              <div style="display:flex; flex-wrap:wrap; gap:8px">
                {INTEGRATION_EVENTS.map((e) => (
                  <label style="display:inline-flex; align-items:center; gap:4px; font-size:12px; background: var(--bg); padding:4px 8px; border-radius:4px; border:1px solid var(--border);">
                    <input type="checkbox" name="events" value={e} />
                    <span style="font-family: ui-monospace, monospace">{e}</span>
                  </label>
                ))}
              </div>
            </FormGroup>
            <Button type="submit" variant="primary">Add integration</Button>
          </Form>
        </Container>
      </Layout>
    );
  }
);

app.post(
  "/:owner/:repo/settings/integrations",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const repo = await ownedRepo(ownerName, repoName, user.id);
    if (!repo) return c.text("Unauthorized", 403);

    const form = await c.req.formData();
    const kindRaw = String(form.get("kind") ?? "");
    const name = String(form.get("name") ?? "").trim();
    const configRaw = String(form.get("config") ?? "{}");
    const events = form
      .getAll("events")
      .map(String)
      .filter(isValidEvent) as IntegrationEvent[];
    if (!isValidKind(kindRaw)) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings/integrations?error=Invalid+connector`
      );
    }
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(configRaw) as Record<string, unknown>;
    } catch {
      return c.redirect(
        `/${ownerName}/${repoName}/settings/integrations?error=Config+must+be+valid+JSON`
      );
    }
    try {
      await createIntegration({
        repositoryId: repo.id,
        kind: kindRaw,
        name,
        config,
        events,
        createdBy: user.id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Create failed";
      return c.redirect(
        `/${ownerName}/${repoName}/settings/integrations?error=${encodeURIComponent(msg)}`
      );
    }
    return c.redirect(
      `/${ownerName}/${repoName}/settings/integrations?success=Integration+added`
    );
  }
);

app.post(
  "/:owner/:repo/settings/integrations/:id/toggle",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName, id } = c.req.param();
    const user = c.get("user")!;
    const repo = await ownedRepo(ownerName, repoName, user.id);
    if (!repo) return c.text("Unauthorized", 403);
    const row = await getById(id);
    if (!row || row.repositoryId !== repo.id) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings/integrations?error=Not+found`
      );
    }
    await updateIntegration(id, { enabled: !row.enabled });
    return c.redirect(
      `/${ownerName}/${repoName}/settings/integrations?success=Updated`
    );
  }
);

app.post(
  "/:owner/:repo/settings/integrations/:id/delete",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName, id } = c.req.param();
    const user = c.get("user")!;
    const repo = await ownedRepo(ownerName, repoName, user.id);
    if (!repo) return c.text("Unauthorized", 403);
    const row = await getById(id);
    if (!row || row.repositoryId !== repo.id) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings/integrations?error=Not+found`
      );
    }
    await deleteIntegration(id);
    return c.redirect(
      `/${ownerName}/${repoName}/settings/integrations?success=Deleted`
    );
  }
);

app.post(
  "/:owner/:repo/settings/integrations/:id/test",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName, id } = c.req.param();
    const user = c.get("user")!;
    const repo = await ownedRepo(ownerName, repoName, user.id);
    if (!repo) return c.text("Unauthorized", 403);
    const row = await getById(id);
    if (!row || row.repositoryId !== repo.id) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings/integrations?error=Not+found`
      );
    }
    const result = await deliverOne(row, "push", {
      repository: `${ownerName}/${repoName}`,
      title: "test event from gluecron",
      synthetic: true,
    });
    const msg =
      result.status === "ok"
        ? `Test delivered (${result.httpStatus ?? "?"}) in ${result.durationMs}ms`
        : `Test failed: ${result.error ?? result.httpStatus ?? "unknown"}`;
    return c.redirect(
      `/${ownerName}/${repoName}/settings/integrations?${
        result.status === "ok" ? "success" : "error"
      }=${encodeURIComponent(msg)}`
    );
  }
);

app.get(
  "/:owner/:repo/settings/integrations/:id/deliveries",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName, id } = c.req.param();
    const user = c.get("user")!;
    const repo = await ownedRepo(ownerName, repoName, user.id);
    if (!repo) return c.text("Unauthorized", 403);
    const row = await getById(id);
    if (!row || row.repositoryId !== repo.id) return c.notFound();
    const deliveries = await listDeliveries(id, 50);
    return c.json({ deliveries });
  }
);

export default app;
