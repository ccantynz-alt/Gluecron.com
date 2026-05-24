/**
 * Block T1 — GitHub Actions secret-migration checklist UI.
 *
 * After a user imports a GitHub repo (see `src/routes/import.tsx`), if their
 * GitHub repo had any Actions secrets we pre-create matching placeholder
 * rows in `workflow_secrets` (via `src/lib/github-secrets-import.ts`) and
 * redirect to `GET /:owner/:repo/import/secrets`. This route renders the
 * one-shot checklist — name + status pill + a password input per row + a
 * "Save" button per row. The Done button always works, even with empty
 * placeholders remaining, because users can come back later via the
 * regular `/settings/secrets` page.
 *
 * Why a separate route from `workflow-secrets.tsx`?
 *   - Different UX shape (vertical checklist vs add-form-on-top table)
 *   - Different copy ("we found N secrets from your GitHub repo")
 *   - Different one-shot lifecycle (cleanup empty placeholders on Done)
 *
 * Empty-vs-filled detection: we decrypt each row and check if plaintext
 * is the empty string. Cheap, accurate, and avoids leaking the "is this
 * a placeholder?" boolean as a database column (which would also force
 * a migration for a feature we shipped behaviourally).
 *
 * CSRF: every POST is guarded by the global `csrfProtect` middleware
 * (see `src/middleware/csrf.ts`); same-origin Origin/Referer check is the
 * primary defence. Each value submission still goes through the existing
 * `upsertRepoSecret` encryption layer — no plaintext storage.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { workflowSecrets } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { Alert, Container, Text } from "../views/ui";
import { upsertRepoSecret, listRepoSecrets } from "../lib/workflow-secrets";
import { decryptSecret } from "../lib/workflow-secrets-crypto";
import { audit } from "../lib/notify";

const importSecretsRoutes = new Hono<AuthEnv>();

importSecretsRoutes.use("*", softAuth);

const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_VALUE_LEN = 32768;

type ChecklistRow = {
  id: string;
  name: string;
  status: "pasted" | "empty";
};

/**
 * Load each secret row for the repo and decrypt it to determine empty
 * (placeholder) vs filled. Returns an empty array on any DB or decrypt
 * failure — the route handler degrades to "no rows" rather than erroring,
 * because this UI is an optional post-import polish step.
 */
async function loadChecklist(repoId: string): Promise<ChecklistRow[]> {
  let rows: { id: string; name: string; encryptedValue: string }[];
  try {
    rows = await db
      .select({
        id: workflowSecrets.id,
        name: workflowSecrets.name,
        encryptedValue: workflowSecrets.encryptedValue,
      })
      .from(workflowSecrets)
      .where(eq(workflowSecrets.repositoryId, repoId));
  } catch {
    return [];
  }

  // Sort: empty placeholders first (so the user works through them), then
  // filled rows alphabetically. Stable within each group.
  const out: ChecklistRow[] = rows.map((r) => {
    const dec = decryptSecret(r.encryptedValue);
    const status: "pasted" | "empty" =
      dec.ok && dec.plaintext === "" ? "empty" : "pasted";
    return { id: r.id, name: r.name, status };
  });
  out.sort((a, b) => {
    if (a.status !== b.status) return a.status === "empty" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

// ─── GET: Checklist ─────────────────────────────────────────────────────────

importSecretsRoutes.get(
  "/:owner/:repo/import/secrets",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const repo = c.get("repository") as { id: string } | undefined;
    if (!repo) return c.notFound();

    const saved = c.req.query("saved");
    const error = c.req.query("error");

    const rows = await loadChecklist(repo.id);
    const emptyCount = rows.filter((r) => r.status === "empty").length;
    const pastedCount = rows.length - emptyCount;

    // If the repo has zero placeholders at all (e.g. the user came back to
    // this URL after finishing earlier, or the secrets migration didn't
    // actually find any rows — empty repo, no token, decrypt failure),
    // redirect back to /import with a success banner explaining what
    // happened. Previously this redirected silently to the repo home with
    // no feedback, so users didn't know whether secrets had migrated or
    // not.
    if (rows.length === 0) {
      return c.redirect(
        `/import?success=${encodeURIComponent(
          `Import of ${ownerName}/${repoName} succeeded. No secrets were migrated — either the GitHub repo has none, the token lacks the 'actions:read' scope, or you already pasted values in a previous session. Open the repo at /${ownerName}/${repoName} to start using it.`
        )}`
      );
    }

    return c.html(
      <Layout
        title={`Import secrets — ${ownerName}/${repoName}`}
        user={user}
      >
        <RepoHeader owner={ownerName} repo={repoName} currentUser={user.username} />
        <RepoNav owner={ownerName} repo={repoName} active="settings" />
        <Container maxWidth={780}>
          <div
            style="position: sticky; top: 0; background: var(--bg); padding: 20px 0 16px; border-bottom: 1px solid var(--border); margin-bottom: 20px; z-index: 5"
          >
            <h2 style="margin-bottom: 6px">
              Migrate {rows.length} secret{rows.length === 1 ? "" : "s"} from GitHub
            </h2>
            <Text size={14} muted style="display:block;margin-bottom:8px">
              We found {rows.length} Actions secret{rows.length === 1 ? "" : "s"} on
              your GitHub repo. Paste each value below to migrate them.{" "}
              <strong>
                {pastedCount} pasted · {emptyCount} still empty
              </strong>
              .
            </Text>
            <Text size={13} muted style="display:block">
              Need the value? Find it in{" "}
              <code style="font-family: var(--font-mono); background: var(--bg-secondary); padding: 1px 6px; border-radius: 4px">
                github.com/{ownerName}/{repoName}/settings/secrets/actions
              </code>
              {" "}— each value is opaque so you can't read it from GitHub, you'll
              need to copy from wherever you originally created it
              (1Password, .env file, etc.).
            </Text>
          </div>

          {saved && (
            <Alert variant="success">
              Saved <code>{decodeURIComponent(saved)}</code>.
            </Alert>
          )}
          {error && <Alert variant="error">{decodeURIComponent(error)}</Alert>}

          <div
            class="panel"
            style="padding: 0; overflow: hidden; margin-top: 8px"
          >
            <table
              class="file-table"
              style="width: 100%; border-collapse: collapse"
            >
              <thead>
                <tr style="background: var(--bg-secondary); text-align: left">
                  <th style="padding: 10px 14px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); width: 40%">
                    Secret name
                  </th>
                  <th style="padding: 10px 14px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); width: 15%">
                    Status
                  </th>
                  <th style="padding: 10px 14px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted)">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const action = `/${ownerName}/${repoName}/import/secrets/${encodeURIComponent(row.name)}`;
                  const pillStyle =
                    row.status === "pasted"
                      ? "background: var(--green-dim, #1f3d2a); color: var(--green, #3fb950); border: 1px solid var(--green, #3fb950)"
                      : "background: var(--yellow-dim, #3d3520); color: var(--yellow, #d29922); border: 1px solid var(--yellow, #d29922)";
                  return (
                    <tr
                      data-secret-row={row.name}
                      style="border-top: 1px solid var(--border); vertical-align: middle"
                    >
                      <td style="padding: 10px 14px">
                        <code style="font-family: var(--font-mono); font-size: 13px">
                          {row.name}
                        </code>
                      </td>
                      <td style="padding: 10px 14px">
                        <span
                          data-status-pill
                          style={
                            "display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 500; " +
                            pillStyle
                          }
                        >
                          {row.status === "pasted" ? "Pasted" : "Empty"}
                        </span>
                      </td>
                      <td style="padding: 10px 14px">
                        <form method="post" action={action} style="display: flex; gap: 8px">
                          <input
                            type="password"
                            name="value"
                            required
                            maxlength={MAX_VALUE_LEN}
                            placeholder={
                              row.status === "pasted"
                                ? "Already saved — paste new value to overwrite"
                                : "Paste value"
                            }
                            autocomplete="off"
                            spellcheck={false}
                            style="flex: 1; font-family: var(--font-mono); font-size: 13px; padding: 6px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text)"
                          />
                          <button
                            type="submit"
                            class="btn btn-primary"
                            style="padding: 6px 14px"
                          >
                            Save
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <form
            method="post"
            action={`/${ownerName}/${repoName}/import/secrets/done`}
            style="margin-top: 24px; display: flex; gap: 12px; align-items: center"
          >
            <button type="submit" class="btn btn-primary">
              Done — take me to my repo
            </button>
            <label style="font-size: 13px; color: var(--text-muted); display: flex; align-items: center; gap: 6px">
              <input
                type="checkbox"
                name="cleanup_empty"
                value="1"
              />
              Also delete the {emptyCount} empty placeholder{emptyCount === 1 ? "" : "s"} on my way out
            </label>
          </form>
        </Container>
      </Layout>
    );
  }
);

// ─── POST: Save one value ───────────────────────────────────────────────────

importSecretsRoutes.post(
  "/:owner/:repo/import/secrets/done",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const repo = c.get("repository") as { id: string } | undefined;
    if (!repo) return c.notFound();

    const body = await c.req.parseBody();
    const cleanup = String(body.cleanup_empty || "") === "1";

    if (cleanup) {
      try {
        const meta = await listRepoSecrets(repo.id);
        if (meta.ok) {
          // Decrypt each row to find empty placeholders, then delete them
          // by id+repo (defensive scope, same shape as deleteRepoSecret).
          const rows = await db
            .select({
              id: workflowSecrets.id,
              name: workflowSecrets.name,
              encryptedValue: workflowSecrets.encryptedValue,
            })
            .from(workflowSecrets)
            .where(eq(workflowSecrets.repositoryId, repo.id));
          let deleted = 0;
          for (const r of rows) {
            const dec = decryptSecret(r.encryptedValue);
            if (dec.ok && dec.plaintext === "") {
              await db
                .delete(workflowSecrets)
                .where(
                  and(
                    eq(workflowSecrets.id, r.id),
                    eq(workflowSecrets.repositoryId, repo.id)
                  )
                );
              deleted++;
            }
          }
          if (deleted > 0) {
            try {
              await audit({
                userId: user.id,
                repositoryId: repo.id,
                action: "workflow.secret.import_cleanup",
                targetType: "repository",
                targetId: repo.id,
                metadata: { deleted },
              });
            } catch {
              // best-effort
            }
          }
        }
      } catch {
        // Cleanup errors never block the redirect — user can re-run via
        // the regular /settings/secrets UI.
      }
    }

    return c.redirect(`/${ownerName}/${repoName}`);
  }
);

importSecretsRoutes.post(
  "/:owner/:repo/import/secrets/:name",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const rawName = c.req.param("name");
    const user = c.get("user")!;
    const repo = c.get("repository") as { id: string } | undefined;
    if (!repo) return c.notFound();

    const base = `/${ownerName}/${repoName}/import/secrets`;
    const fail = (msg: string) =>
      c.redirect(`${base}?error=${encodeURIComponent(msg)}`);

    const name = (rawName || "").trim();
    if (!name || !SECRET_NAME_RE.test(name)) {
      return fail("Invalid secret name");
    }

    const body = await c.req.parseBody();
    const value = typeof body.value === "string" ? body.value : "";

    if (!value) return fail("Value is required");
    if (value.length > MAX_VALUE_LEN)
      return fail(`Value must be <= ${MAX_VALUE_LEN} characters`);

    const result = await upsertRepoSecret({
      repoId: repo.id,
      name,
      value,
      createdBy: user.id,
    });

    if (!result.ok) return fail(result.error);

    try {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "workflow.secret.import_pasted",
        targetType: "workflow_secret",
        targetId: result.id,
        metadata: { name },
      });
    } catch {
      // best-effort
    }

    return c.redirect(`${base}?saved=${encodeURIComponent(name)}`);
  }
);

export default importSecretsRoutes;
