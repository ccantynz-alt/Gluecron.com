/**
 * Per-repo workflow secrets — settings UI for listing, creating, and deleting
 * encrypted secrets that are substituted into workflow steps at runtime.
 *
 * Shape mirrors `src/routes/tokens.tsx` + `src/routes/webhooks.tsx`:
 *   - JSX page rendered through Layout + RepoHeader + RepoNav (active=settings).
 *   - Flash state via `?added=NAME | ?deleted=1 | ?error=...` query params.
 *   - Every mutating route is gated on `requireAuth` + `requireRepoAccess("admin")`.
 *
 * The UI never sees plaintext values after upsert — the `listRepoSecrets`
 * helper in `../lib/workflow-secrets` returns metadata only (id, name,
 * createdAt, createdBy). This file's sole job is to render and mutate.
 */

import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import {
  Container,
  Alert,
  EmptyState,
  Button,
  Text,
  formatRelative,
} from "../views/ui";
import {
  listRepoSecrets,
  upsertRepoSecret,
  deleteRepoSecret,
} from "../lib/workflow-secrets";
import { audit } from "../lib/notify";

const workflowSecretsRoutes = new Hono<AuthEnv>();

workflowSecretsRoutes.use("*", softAuth);

const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_NAME_LEN = 100;
const MAX_VALUE_LEN = 32768;

/** Sub-nav shown under the main RepoNav for repo settings pages. */
function SettingsSubNav({
  owner,
  repo,
  active,
}: {
  owner: string;
  repo: string;
  active: "general" | "collaborators" | "webhooks" | "secrets";
}) {
  const link = (
    href: string,
    label: string,
    key: "general" | "collaborators" | "webhooks" | "secrets"
  ) => (
    <a
      href={href}
      style={
        "padding: 6px 12px; border-radius: 6px; text-decoration: none; " +
        (active === key
          ? "background: var(--bg-secondary); color: var(--text); font-weight: 600"
          : "color: var(--text-muted)")
      }
    >
      {label}
    </a>
  );
  return (
    <div
      style="display: flex; gap: 4px; margin: 12px 0 20px; padding-bottom: 12px; border-bottom: 1px solid var(--border)"
    >
      {link(`/${owner}/${repo}/settings`, "General", "general")}
      {link(
        `/${owner}/${repo}/settings/collaborators`,
        "Collaborators",
        "collaborators"
      )}
      {link(
        `/${owner}/${repo}/settings/webhooks`,
        "Webhooks",
        "webhooks"
      )}
      {link(
        `/${owner}/${repo}/settings/secrets`,
        "Secrets",
        "secrets"
      )}
    </div>
  );
}

// ─── GET: List + add form ───────────────────────────────────────────────────

workflowSecretsRoutes.get(
  "/:owner/:repo/settings/secrets",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const repo = c.get("repository") as { id: string } | undefined;

    const added = c.req.query("added");
    const deleted = c.req.query("deleted");
    const error = c.req.query("error");

    if (!repo) {
      return c.notFound();
    }

    const result = await listRepoSecrets(repo.id);
    const secrets = result.ok ? result.secrets : [];
    const loadError = result.ok ? null : result.error;

    // Resolve createdBy user ids -> usernames for display/linking.
    const creatorIds = Array.from(
      new Set(secrets.map((s) => s.createdBy).filter(Boolean) as string[])
    );
    const creatorRows = creatorIds.length
      ? await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(inArray(users.id, creatorIds))
      : [];
    const creatorMap = new Map(creatorRows.map((r) => [r.id, r.username]));

    return c.html(
      <Layout title={`Secrets — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} currentUser={user.username} />
        <RepoNav owner={ownerName} repo={repoName} active="settings" />
        <Container maxWidth={760}>
          <SettingsSubNav
            owner={ownerName}
            repo={repoName}
            active="secrets"
          />

          <h2 style="margin-bottom: 8px">Workflow secrets</h2>
          <Text size={14} muted style="display:block;margin-bottom:20px">
            Secrets are encrypted at rest and only decrypted at workflow
            runtime. They are never printed to logs. Reference them in YAML
            as{" "}
            <code style="font-family: var(--font-mono); background: var(--bg-secondary); padding: 1px 6px; border-radius: 4px">
              {"${{ secrets.NAME }}"}
            </code>
            . Values are write-only — after saving, only the name is
            visible.
          </Text>

          {added && (
            <Alert variant="success">
              Secret <code>{decodeURIComponent(added)}</code> saved.
            </Alert>
          )}
          {deleted && <Alert variant="success">Secret deleted.</Alert>}
          {error && (
            <Alert variant="error">{decodeURIComponent(error)}</Alert>
          )}
          {loadError && (
            <Alert variant="error">
              Could not load secrets: {loadError}
            </Alert>
          )}

          <div class="panel" style="margin-top: 16px; padding: 0; overflow: hidden">
            {secrets.length === 0 ? (
              <div style="padding: 24px">
                <EmptyState>
                  <Text muted>No secrets yet.</Text>
                </EmptyState>
              </div>
            ) : (
              <table
                class="file-table"
                style="width: 100%; border-collapse: collapse"
              >
                <thead>
                  <tr style="background: var(--bg-secondary); text-align: left">
                    <th style="padding: 10px 14px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted)">
                      Name
                    </th>
                    <th style="padding: 10px 14px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted)">
                      Added by
                    </th>
                    <th style="padding: 10px 14px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted)">
                      Added
                    </th>
                    <th style="padding: 10px 14px" />
                  </tr>
                </thead>
                <tbody>
                  {secrets.map((s) => {
                    const creator = s.createdBy
                      ? creatorMap.get(s.createdBy)
                      : null;
                    return (
                      <tr style="border-top: 1px solid var(--border)">
                        <td style="padding: 10px 14px">
                          <code
                            style="font-family: var(--font-mono); font-size: 13px"
                          >
                            {s.name}
                          </code>
                        </td>
                        <td style="padding: 10px 14px; font-size: 13px">
                          {creator ? (
                            <a href={`/${creator}`}>{creator}</a>
                          ) : (
                            <span style="color: var(--text-muted)">
                              unknown
                            </span>
                          )}
                        </td>
                        <td
                          style="padding: 10px 14px; font-size: 13px; color: var(--text-muted)"
                          title={
                            s.createdAt
                              ? new Date(s.createdAt).toISOString()
                              : ""
                          }
                        >
                          {s.createdAt
                            ? formatRelative(s.createdAt)
                            : "—"}
                        </td>
                        <td style="padding: 10px 14px; text-align: right">
                          <form
                            method="post"
                            action={`/${ownerName}/${repoName}/settings/secrets/${s.id}/delete`}
                            style="display: inline"
                            onsubmit={`return confirm('Delete secret ${s.name}?')`}
                          >
                            <Button
                              type="submit"
                              variant="danger"
                              size="sm"
                            >
                              Delete
                            </Button>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <h3 style="margin-top: 32px; margin-bottom: 4px">
            Add a new secret
          </h3>
          <Text size={13} muted style="display:block;margin-bottom:12px">
            Names must be uppercase letters, digits, and underscores, and
            cannot start with a digit. Adding a secret with an existing
            name replaces the stored value.
          </Text>
          <form
            method="post"
            action={`/${ownerName}/${repoName}/settings/secrets`}
          >
            <div class="form-group">
              <label for="secret-name">Name</label>
              <input
                type="text"
                id="secret-name"
                name="name"
                required
                pattern="[A-Z_][A-Z0-9_]*"
                maxlength={MAX_NAME_LEN}
                placeholder="DEPLOY_TOKEN"
                autocomplete="off"
                style="font-family: var(--font-mono)"
                title="Uppercase letters, digits, and underscores; cannot start with a digit"
              />
            </div>
            <div class="form-group">
              <label for="secret-value">Value</label>
              <textarea
                id="secret-value"
                name="value"
                required
                rows={4}
                maxlength={MAX_VALUE_LEN}
                placeholder="Paste secret value"
                autocomplete="off"
                spellcheck={false}
                style="width: 100%; font-family: var(--font-mono); font-size: 13px"
              />
            </div>
            <button type="submit" class="btn btn-primary">
              Add secret
            </button>
          </form>
        </Container>
      </Layout>
    );
  }
);

// ─── POST: Create / update ──────────────────────────────────────────────────

workflowSecretsRoutes.post(
  "/:owner/:repo/settings/secrets",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const repo = c.get("repository") as { id: string } | undefined;
    if (!repo) return c.notFound();

    const body = await c.req.parseBody();
    const name = String(body.name || "").trim();
    const value = typeof body.value === "string" ? body.value : "";

    const base = `/${ownerName}/${repoName}/settings/secrets`;
    const fail = (msg: string) =>
      c.redirect(`${base}?error=${encodeURIComponent(msg)}`);

    if (!name) return fail("Name is required");
    if (name.length > MAX_NAME_LEN)
      return fail(`Name must be ≤ ${MAX_NAME_LEN} characters`);
    if (!SECRET_NAME_RE.test(name))
      return fail(
        "Name must be uppercase letters, digits, and underscores, and cannot start with a digit"
      );
    if (!value) return fail("Value is required");
    if (value.length > MAX_VALUE_LEN)
      return fail(`Value must be ≤ ${MAX_VALUE_LEN} characters`);

    const result = await upsertRepoSecret({
      repoId: repo.id,
      name,
      value,
      createdBy: user.id,
    });

    if (!result.ok) return fail(result.error);

    // Best-effort audit — swallow any error so it never breaks the redirect.
    try {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "workflow.secret.create",
        targetType: "workflow_secret",
        targetId: result.id,
        metadata: { name },
      });
    } catch {
      // audit() already swallows errors, but guard anyway.
    }

    return c.redirect(`${base}?added=${encodeURIComponent(name)}`);
  }
);

// ─── POST: Delete ───────────────────────────────────────────────────────────

workflowSecretsRoutes.post(
  "/:owner/:repo/settings/secrets/:secretId/delete",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const repo = c.get("repository") as { id: string } | undefined;
    if (!repo) return c.notFound();

    const secretId = c.req.param("secretId");
    const base = `/${ownerName}/${repoName}/settings/secrets`;

    if (!secretId) {
      return c.redirect(`${base}?error=${encodeURIComponent("Missing secret id")}`);
    }

    const result = await deleteRepoSecret({
      repoId: repo.id,
      secretId,
    });

    if (!result.ok) {
      return c.redirect(
        `${base}?error=${encodeURIComponent(result.error)}`
      );
    }

    try {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "workflow.secret.delete",
        targetType: "workflow_secret",
        targetId: secretId,
      });
    } catch {
      // best-effort
    }

    return c.redirect(`${base}?deleted=1`);
  }
);

export default workflowSecretsRoutes;
