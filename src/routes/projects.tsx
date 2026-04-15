/**
 * Block E1 — Projects / Kanban boards scoped to a repo.
 *
 * Each project has ordered columns ("To Do" / "In Progress" / "Done" by
 * default) and items (notes or linked issues/PRs). Items belong to exactly
 * one column at a time. Simple v1: positions are recomputed via "max+1".
 *
 * Never throws — all DB paths wrapped in try/catch.
 */

import { Hono } from "hono";
import { and, eq, desc, asc, sql } from "drizzle-orm";
import { db } from "../db";
import {
  projects,
  projectColumns,
  projectItems,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const DEFAULT_COLUMNS = ["To Do", "In Progress", "Done"] as const;

const projectRoutes = new Hono<AuthEnv>();

async function resolveRepo(ownerName: string, repoName: string) {
  try {
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner) return null;
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
    if (!repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

function notFound(user: any, label = "Not found") {
  return (
    <Layout title={label} user={user}>
      <div class="empty-state">
        <h2>{label}</h2>
      </div>
    </Layout>
  );
}

// List
projectRoutes.get("/:owner/:repo/projects", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.html(notFound(user, "Repository not found"), 404);
  const { repo } = resolved;

  let rows: any[] = [];
  try {
    rows = await db
      .select({
        p: projects,
        columnCount: sql<number>`(SELECT count(*) FROM project_columns WHERE project_id = ${projects.id})`,
        itemCount: sql<number>`(SELECT count(*) FROM project_items WHERE project_id = ${projects.id})`,
      })
      .from(projects)
      .where(eq(projects.repositoryId, repo.id))
      .orderBy(desc(projects.updatedAt));
  } catch {
    rows = [];
  }

  return c.html(
    <Layout title={`Projects — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div style="display: flex; justify-content: space-between; align-items: center; margin: 16px 0;">
        <h2 style="margin: 0;">Projects</h2>
        {user && (
          <a
            href={`/${ownerName}/${repoName}/projects/new`}
            class="btn btn-primary"
          >
            New project
          </a>
        )}
      </div>
      {rows.length === 0 ? (
        <div class="empty-state">
          <p>No projects yet.</p>
        </div>
      ) : (
        <table class="file-table">
          <tbody>
            {rows.map((r) => (
              <tr>
                <td style="width: 40px; color: var(--text-muted);">
                  #{r.p.number}
                </td>
                <td>
                  <a
                    href={`/${ownerName}/${repoName}/projects/${r.p.number}`}
                  >
                    <strong>{r.p.title}</strong>
                  </a>
                  {r.p.state === "closed" && <span class="badge">closed</span>}
                  {r.p.description && (
                    <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                      {r.p.description}
                    </div>
                  )}
                </td>
                <td style="text-align: right; color: var(--text-muted); font-size: 13px;">
                  {r.columnCount} cols · {r.itemCount} items
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Layout>
  );
});

// New form
projectRoutes.get(
  "/:owner/:repo/projects/new",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user");
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.html(notFound(user, "Repository not found"), 404);
    return c.html(
      <Layout title="New project" user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <h2 style="margin-top: 20px;">Create a project</h2>
        <form
          method="POST"
          action={`/${ownerName}/${repoName}/projects`}
          style="display: flex; flex-direction: column; gap: 12px; margin-top: 16px;"
        >
          <input
            type="text"
            name="title"
            placeholder="Title"
            required
            style="padding: 8px;"
          />
          <textarea
            name="description"
            rows={4}
            placeholder="Description (optional)"
            style="padding: 8px; font-family: inherit;"
          ></textarea>
          <button type="submit" class="btn btn-primary">
            Create
          </button>
        </form>
      </Layout>
    );
  }
);

// Create
projectRoutes.post(
  "/:owner/:repo/projects",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const form = await c.req.formData();
    const title = (form.get("title") as string || "").trim();
    const description = (form.get("description") as string || "").trim();

    if (!title) {
      return c.redirect(`/${ownerName}/${repoName}/projects/new`);
    }

    try {
      const [row] = await db
        .insert(projects)
        .values({
          repositoryId: resolved.repo.id,
          ownerId: user.id,
          title,
          description,
        })
        .returning({ id: projects.id, number: projects.number });
      // Seed default columns
      await db.insert(projectColumns).values(
        DEFAULT_COLUMNS.map((name, i) => ({
          projectId: row.id,
          name,
          position: i,
        }))
      );
      return c.redirect(`/${ownerName}/${repoName}/projects/${row.number}`);
    } catch {
      return c.redirect(`/${ownerName}/${repoName}/projects`);
    }
  }
);

// Board view
projectRoutes.get(
  "/:owner/:repo/projects/:number",
  softAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user");
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.html(notFound(user, "Repository not found"), 404);

    let project: any = null;
    let columns: any[] = [];
    let items: any[] = [];
    try {
      const [row] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.repositoryId, resolved.repo.id),
            eq(projects.number, numParam)
          )
        )
        .limit(1);
      if (row) {
        project = row;
        columns = await db
          .select()
          .from(projectColumns)
          .where(eq(projectColumns.projectId, row.id))
          .orderBy(asc(projectColumns.position), asc(projectColumns.createdAt));
        items = await db
          .select()
          .from(projectItems)
          .where(eq(projectItems.projectId, row.id))
          .orderBy(asc(projectItems.position));
      }
    } catch {
      // leave nulls
    }

    if (!project) return c.html(notFound(user, "Project not found"), 404);

    const isOwner = user && user.id === resolved.repo.ownerId;
    const itemsByCol: Record<string, any[]> = {};
    for (const col of columns) itemsByCol[col.id] = [];
    for (const it of items) {
      if (itemsByCol[it.columnId]) itemsByCol[it.columnId].push(it);
    }

    return c.html(
      <Layout
        title={`${project.title} — project #${project.number}`}
        user={user}
      >
        <RepoHeader owner={ownerName} repo={repoName} />
        <style>{`
          .kanban { display: flex; gap: 16px; overflow-x: auto; padding: 16px 0; }
          .kcol { background: var(--bg-soft); border: 1px solid var(--border); border-radius: 6px; min-width: 260px; flex-shrink: 0; padding: 12px; }
          .kcol h4 { margin: 0 0 12px; display: flex; justify-content: space-between; }
          .kcard { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px; margin-bottom: 8px; font-size: 13px; }
          .kcard form { display: inline; }
        `}</style>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px;">
          <h1 style="margin: 0;">
            {project.title}{" "}
            <span style="color: var(--text-muted);">#{project.number}</span>
            {project.state === "closed" && <span class="badge">closed</span>}
          </h1>
          {user && (
            <form
              method="POST"
              action={`/${ownerName}/${repoName}/projects/${project.number}/close`}
              style="display: inline;"
            >
              <button type="submit" class="btn">
                {project.state === "open" ? "Close" : "Reopen"}
              </button>
            </form>
          )}
        </div>
        {project.description && (
          <div style="color: var(--text-muted); margin-top: 4px;">
            {project.description}
          </div>
        )}
        <div class="kanban">
          {columns.map((col) => (
            <div class="kcol">
              <h4>
                <span>{col.name}</span>
                <span style="color: var(--text-muted); font-size: 13px;">
                  {(itemsByCol[col.id] || []).length}
                </span>
              </h4>
              {(itemsByCol[col.id] || []).map((it) => (
                <div class="kcard">
                  <div>
                    <strong>{it.title || "(untitled)"}</strong>
                  </div>
                  {it.note && (
                    <div style="color: var(--text-muted); margin-top: 4px;">
                      {it.note}
                    </div>
                  )}
                  {user && (
                    <div style="margin-top: 8px; display: flex; gap: 4px; flex-wrap: wrap;">
                      {columns
                        .filter((oc) => oc.id !== col.id)
                        .map((oc) => (
                          <form
                            method="POST"
                            action={`/${ownerName}/${repoName}/projects/${project.number}/items/${it.id}/move`}
                          >
                            <input
                              type="hidden"
                              name="column_id"
                              value={oc.id}
                            />
                            <button
                              type="submit"
                              class="btn"
                              style="font-size: 11px; padding: 2px 6px;"
                            >
                              → {oc.name}
                            </button>
                          </form>
                        ))}
                      <form
                        method="POST"
                        action={`/${ownerName}/${repoName}/projects/${project.number}/items/${it.id}/delete`}
                      >
                        <button
                          type="submit"
                          class="btn"
                          style="font-size: 11px; padding: 2px 6px;"
                        >
                          ×
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              ))}
              {user && (
                <form
                  method="POST"
                  action={`/${ownerName}/${repoName}/projects/${project.number}/items`}
                  style="margin-top: 8px; display: flex; flex-direction: column; gap: 4px;"
                >
                  <input type="hidden" name="column_id" value={col.id} />
                  <input
                    type="text"
                    name="title"
                    placeholder="New card title"
                    required
                    style="padding: 4px; font-size: 12px;"
                  />
                  <button
                    type="submit"
                    class="btn"
                    style="font-size: 12px; padding: 4px;"
                  >
                    + Add card
                  </button>
                </form>
              )}
            </div>
          ))}
          {user && (
            <div class="kcol" style="background: transparent; border-style: dashed;">
              <form
                method="POST"
                action={`/${ownerName}/${repoName}/projects/${project.number}/columns`}
                style="display: flex; flex-direction: column; gap: 8px;"
              >
                <input
                  type="text"
                  name="name"
                  placeholder="New column"
                  required
                  style="padding: 6px;"
                />
                <button type="submit" class="btn">
                  + Add column
                </button>
              </form>
            </div>
          )}
        </div>
      </Layout>
    );
  }
);

// Add column
projectRoutes.post(
  "/:owner/:repo/projects/:number/columns",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}/projects`);

    const form = await c.req.formData();
    const name = (form.get("name") as string || "").trim();
    if (!name) {
      return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
    }

    try {
      const [row] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.repositoryId, resolved.repo.id),
            eq(projects.number, numParam)
          )
        )
        .limit(1);
      if (row) {
        const [maxPos] = await db
          .select({ p: sql<number>`coalesce(max(${projectColumns.position}), -1)` })
          .from(projectColumns)
          .where(eq(projectColumns.projectId, row.id));
        await db.insert(projectColumns).values({
          projectId: row.id,
          name,
          position: Number(maxPos?.p || -1) + 1,
        });
      }
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
  }
);

// Add item
projectRoutes.post(
  "/:owner/:repo/projects/:number/items",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}/projects`);

    const form = await c.req.formData();
    const columnId = (form.get("column_id") as string || "").trim();
    const title = (form.get("title") as string || "").trim();
    const note = (form.get("note") as string || "").trim();
    if (!columnId || !title) {
      return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
    }

    try {
      const [row] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.repositoryId, resolved.repo.id),
            eq(projects.number, numParam)
          )
        )
        .limit(1);
      if (row) {
        const [maxPos] = await db
          .select({ p: sql<number>`coalesce(max(${projectItems.position}), -1)` })
          .from(projectItems)
          .where(eq(projectItems.columnId, columnId));
        await db.insert(projectItems).values({
          projectId: row.id,
          columnId,
          title,
          note,
          position: Number(maxPos?.p || -1) + 1,
        });
      }
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
  }
);

// Move item
projectRoutes.post(
  "/:owner/:repo/projects/:number/items/:itemId/move",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, itemId } = c.req.param();
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}/projects`);

    const form = await c.req.formData();
    const columnId = (form.get("column_id") as string || "").trim();
    if (!columnId) {
      return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
    }

    try {
      const [maxPos] = await db
        .select({ p: sql<number>`coalesce(max(${projectItems.position}), -1)` })
        .from(projectItems)
        .where(eq(projectItems.columnId, columnId));
      await db
        .update(projectItems)
        .set({
          columnId,
          position: Number(maxPos?.p || -1) + 1,
          updatedAt: new Date(),
        })
        .where(eq(projectItems.id, itemId));
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
  }
);

// Delete item
projectRoutes.post(
  "/:owner/:repo/projects/:number/items/:itemId/delete",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, itemId } = c.req.param();
    const numParam = Number(c.req.param("number"));
    try {
      await db.delete(projectItems).where(eq(projectItems.id, itemId));
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
  }
);

// Toggle close
projectRoutes.post(
  "/:owner/:repo/projects/:number/close",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}/projects`);

    try {
      const [row] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.repositoryId, resolved.repo.id),
            eq(projects.number, numParam)
          )
        )
        .limit(1);
      if (row) {
        await db
          .update(projects)
          .set({
            state: row.state === "open" ? "closed" : "open",
            updatedAt: new Date(),
          })
          .where(eq(projects.id, row.id));
      }
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/projects/${numParam}`);
  }
);

export default projectRoutes;
