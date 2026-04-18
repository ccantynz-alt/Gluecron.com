/**
 * Block E4 — Gists: user-owned tiny multi-file repos.
 *
 * DB-backed v1 (no git bare repo). Each gist owns a collection of gist_files,
 * and every edit appends a gist_revisions row with a JSON snapshot of the
 * full file set at that revision.
 *
 * Never throws — all DB paths wrapped in try/catch; any failure redirects.
 */

import { Hono } from "hono";
import { and, eq, desc, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db } from "../db";
import {
  gists,
  gistFiles,
  gistRevisions,
  gistStars,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { highlightCode } from "../lib/highlight";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { html } from "hono/html";

export function generateSlug(): string {
  return randomBytes(4).toString("hex");
}

export function snapshotOf(
  files: { filename: string; content: string }[]
): string {
  const map: Record<string, string> = {};
  for (const f of files) map[f.filename] = f.content;
  return JSON.stringify(map);
}

const gistRoutes = new Hono<AuthEnv>();

function notFound(user: any, label = "Gist not found") {
  return (
    <Layout title={label} user={user}>
      <div class="empty-state">
        <h2>{label}</h2>
      </div>
    </Layout>
  );
}

// Discover / list public gists
gistRoutes.get("/gists", softAuth, async (c) => {
  const user = c.get("user");
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = 30;
  const offset = (page - 1) * limit;

  let rows: any[] = [];
  try {
    rows = await db
      .select({
        g: gists,
        owner: { username: users.username },
        fileCount: sql<number>`(SELECT count(*) FROM gist_files WHERE gist_id = ${gists.id})`,
        starCount: sql<number>`(SELECT count(*) FROM gist_stars WHERE gist_id = ${gists.id})`,
      })
      .from(gists)
      .innerJoin(users, eq(gists.ownerId, users.id))
      .where(eq(gists.isPublic, true))
      .orderBy(desc(gists.updatedAt))
      .limit(limit)
      .offset(offset);
  } catch {
    rows = [];
  }

  return c.html(
    <Layout title="Discover gists" user={user}>
      <div style="display: flex; justify-content: space-between; align-items: center; margin: 16px 0;">
        <h1 style="margin: 0;">Discover gists</h1>
        {user && (
          <a href="/gists/new" class="btn btn-primary">
            + New gist
          </a>
        )}
      </div>
      {rows.length === 0 ? (
        <div class="empty-state">
          <p>No public gists yet.</p>
        </div>
      ) : (
        <div class="commit-list">
          {rows.map((r) => (
            <div class="commit-item">
              <div>
                <div class="commit-message">
                  <a href={`/gists/${r.g.slug}`}>
                    <strong>{r.g.title || r.g.slug}</strong>
                  </a>
                </div>
                <div class="commit-meta">
                  by <a href={`/${r.owner.username}`}>@{r.owner.username}</a>{" "}
                  · {r.fileCount} file{r.fileCount !== 1 ? "s" : ""} · ★{" "}
                  {r.starCount}
                  {r.g.description && ` · ${r.g.description}`}
                </div>
              </div>
              <a href={`/gists/${r.g.slug}`} class="commit-sha">
                {r.g.slug}
              </a>
            </div>
          ))}
        </div>
      )}
      {(rows.length === limit || page > 1) && (
        <div style="margin-top: 16px;">
          {page > 1 && <a href={`/gists?page=${page - 1}`}>← prev</a>}
          {"  "}
          {rows.length === limit && (
            <a href={`/gists?page=${page + 1}`}>next →</a>
          )}
        </div>
      )}
    </Layout>
  );
});

// New gist form
gistRoutes.get("/gists/new", requireAuth, async (c) => {
  const user = c.get("user");
  return c.html(
    <Layout title="New gist" user={user}>
      <h1 style="margin-top: 20px;">Create a gist</h1>
      <form
        method="POST"
        action="/gists"
        style="display: flex; flex-direction: column; gap: 12px; margin-top: 16px;"
      >
        <input
          type="text"
          name="description"
          placeholder="Gist description..."
          style="padding: 8px;"
        />
        <div style="display: flex; gap: 16px;">
          <label>
            <input type="radio" name="is_public" value="true" checked />{" "}
            Public
          </label>
          <label>
            <input type="radio" name="is_public" value="false" /> Secret
          </label>
        </div>
        <div id="files">
          <div class="gist-file" style="border: 1px solid var(--border); padding: 12px; margin-bottom: 8px;">
            <input
              type="text"
              name="filename[]"
              placeholder="filename.ext"
              required
              style="padding: 6px; width: 300px;"
            />
            <textarea
              name="content[]"
              rows={12}
              placeholder="File contents..."
              required
              style="width: 100%; padding: 8px; font-family: monospace; margin-top: 8px;"
            ></textarea>
          </div>
        </div>
        <button
          type="button"
          class="btn"
          id="add-file"
          style="align-self: flex-start;"
        >
          + Add file
        </button>
        <button type="submit" class="btn btn-primary">
          Create gist
        </button>
      </form>
      {html`
        <script>
          document.getElementById("add-file").addEventListener("click", () => {
            const div = document.createElement("div");
            div.className = "gist-file";
            div.style.cssText = "border: 1px solid var(--border); padding: 12px; margin-bottom: 8px;";
            div.innerHTML =
              '<input type="text" name="filename[]" placeholder="filename.ext" required style="padding: 6px; width: 300px;" />' +
              '<textarea name="content[]" rows="12" placeholder="File contents..." required style="width: 100%; padding: 8px; font-family: monospace; margin-top: 8px;"></textarea>';
            document.getElementById("files").appendChild(div);
          });
        </script>
      `}
    </Layout>
  );
});

// Create gist
gistRoutes.post("/gists", requireAuth, async (c) => {
  const user = c.get("user")!;
  const form = await c.req.formData();
  const description = (form.get("description") as string || "").trim();
  const isPublic = (form.get("is_public") as string) !== "false";
  const filenames = form.getAll("filename[]") as string[];
  const contents = form.getAll("content[]") as string[];

  const files = filenames
    .map((fn, i) => ({
      filename: (fn || "").trim(),
      content: contents[i] || "",
    }))
    .filter((f) => f.filename && f.content);

  if (files.length === 0) {
    return c.text("At least one file is required", 400);
  }

  // Retry on unique slug collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = generateSlug();
    try {
      const [gist] = await db
        .insert(gists)
        .values({
          ownerId: user.id,
          slug,
          title: files[0].filename,
          description,
          isPublic,
        })
        .returning({ id: gists.id });
      await db.insert(gistFiles).values(
        files.map((f) => ({
          gistId: gist.id,
          filename: f.filename,
          content: f.content,
          sizeBytes: new TextEncoder().encode(f.content).length,
        }))
      );
      await db.insert(gistRevisions).values({
        gistId: gist.id,
        revision: 1,
        snapshot: snapshotOf(files),
        authorId: user.id,
        message: "Initial",
      });
      return c.redirect(`/gists/${slug}`);
    } catch (err: any) {
      if (attempt === 4) {
        return c.text("Could not create gist", 500);
      }
      // Otherwise assume slug collision, retry with fresh slug.
    }
  }
  return c.redirect("/gists");
});

// View gist
gistRoutes.get("/gists/:slug", softAuth, async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");

  let gist: any = null;
  let files: any[] = [];
  let starCount = 0;
  let isStarred = false;
  try {
    const [row] = await db
      .select({ g: gists, owner: { username: users.username } })
      .from(gists)
      .innerJoin(users, eq(gists.ownerId, users.id))
      .where(eq(gists.slug, slug))
      .limit(1);
    if (row) {
      gist = row;
      files = await db
        .select()
        .from(gistFiles)
        .where(eq(gistFiles.gistId, gist.g.id))
        .orderBy(gistFiles.filename);
      const [cnt] = await db
        .select({ n: sql<number>`count(*)` })
        .from(gistStars)
        .where(eq(gistStars.gistId, gist.g.id));
      starCount = Number(cnt?.n || 0);
      if (user) {
        const [has] = await db
          .select()
          .from(gistStars)
          .where(
            and(
              eq(gistStars.gistId, gist.g.id),
              eq(gistStars.userId, user.id)
            )
          )
          .limit(1);
        isStarred = !!has;
      }
    }
  } catch {
    // leave null
  }

  if (!gist) return c.html(notFound(user), 404);

  const isOwner = user && user.id === gist.g.ownerId;
  if (!gist.g.isPublic && !isOwner) {
    return c.html(notFound(user), 404);
  }

  return c.html(
    <Layout title={gist.g.title || slug} user={user}>
      <div style="display: flex; justify-content: space-between; align-items: center; margin: 16px 0;">
        <div>
          <h1 style="margin: 0;">
            <a href={`/${gist.owner.username}`}>@{gist.owner.username}</a>{" "}
            <span style="color: var(--text-muted);">/</span>{" "}
            {gist.g.title || slug}
            {!gist.g.isPublic && <span class="badge">Secret</span>}
          </h1>
          {gist.g.description && (
            <div style="color: var(--text-muted); margin-top: 4px;">
              {gist.g.description}
            </div>
          )}
        </div>
        <div style="display: flex; gap: 8px;">
          {user && !isOwner && (
            <form
              method="POST"
              action={`/gists/${slug}/star`}
              style="display: inline;"
            >
              <button
                type="submit"
                class={`star-btn${isStarred ? " starred" : ""}`}
              >
                {isStarred ? "★" : "☆"} {starCount}
              </button>
            </form>
          )}
          {!user && (
            <span class="star-btn">☆ {starCount}</span>
          )}
          <a href={`/gists/${slug}/revisions`} class="btn">
            Revisions
          </a>
          {isOwner && (
            <>
              <a href={`/gists/${slug}/edit`} class="btn">
                Edit
              </a>
              <form
                method="POST"
                action={`/gists/${slug}/delete`}
                style="display: inline;"
                onsubmit="return confirm('Delete this gist?')"
              >
                <button type="submit" class="btn">
                  Delete
                </button>
              </form>
            </>
          )}
        </div>
      </div>
      {files.map((f) => {
        const { html: highlighted } = highlightCode(f.content, f.filename);
        return (
          <div style="margin-top: 16px; border: 1px solid var(--border); border-radius: 6px;">
            <div class="diff-file-header">{f.filename}</div>
            <div class="blob-code">
              <pre style="margin: 0; padding: 12px; font-size: 13px; line-height: 1.6; overflow-x: auto;">
                {html([highlighted] as unknown as TemplateStringsArray)}
              </pre>
            </div>
          </div>
        );
      })}
    </Layout>
  );
});

// Edit form
gistRoutes.get("/gists/:slug/edit", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");

  let gist: any = null;
  let files: any[] = [];
  try {
    const [row] = await db
      .select()
      .from(gists)
      .where(eq(gists.slug, slug))
      .limit(1);
    if (row && row.ownerId === user.id) {
      gist = row;
      files = await db
        .select()
        .from(gistFiles)
        .where(eq(gistFiles.gistId, gist.id))
        .orderBy(gistFiles.filename);
    }
  } catch {
    // leave null
  }

  if (!gist) return c.html(notFound(user, "Not found or not yours"), 404);

  return c.html(
    <Layout title={`Edit ${gist.slug}`} user={user}>
      <h1 style="margin-top: 20px;">Edit gist</h1>
      <form
        method="POST"
        action={`/gists/${slug}/edit`}
        style="display: flex; flex-direction: column; gap: 12px; margin-top: 16px;"
      >
        <input
          type="text"
          name="description"
          value={gist.description}
          placeholder="Description"
          style="padding: 8px;"
        />
        <input
          type="text"
          name="message"
          placeholder="Revision message (optional)"
          style="padding: 8px;"
        />
        <div id="files">
          {files.map((f) => (
            <div class="gist-file" style="border: 1px solid var(--border); padding: 12px; margin-bottom: 8px;">
              <input
                type="text"
                name="filename[]"
                value={f.filename}
                required
                style="padding: 6px; width: 300px;"
              />
              <textarea
                name="content[]"
                rows={12}
                required
                style="width: 100%; padding: 8px; font-family: monospace; margin-top: 8px;"
              >
                {f.content}
              </textarea>
            </div>
          ))}
        </div>
        <button
          type="button"
          class="btn"
          id="add-file"
          style="align-self: flex-start;"
        >
          + Add file
        </button>
        <button type="submit" class="btn btn-primary">
          Save revision
        </button>
      </form>
      {html`
        <script>
          document.getElementById("add-file").addEventListener("click", () => {
            const div = document.createElement("div");
            div.className = "gist-file";
            div.style.cssText = "border: 1px solid var(--border); padding: 12px; margin-bottom: 8px;";
            div.innerHTML =
              '<input type="text" name="filename[]" placeholder="filename.ext" required style="padding: 6px; width: 300px;" />' +
              '<textarea name="content[]" rows="12" required style="width: 100%; padding: 8px; font-family: monospace; margin-top: 8px;"></textarea>';
            document.getElementById("files").appendChild(div);
          });
        </script>
      `}
    </Layout>
  );
});

// Save edit
gistRoutes.post("/gists/:slug/edit", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const form = await c.req.formData();
  const description = (form.get("description") as string || "").trim();
  const message = (form.get("message") as string || "").trim();
  const filenames = form.getAll("filename[]") as string[];
  const contents = form.getAll("content[]") as string[];

  const files = filenames
    .map((fn, i) => ({
      filename: (fn || "").trim(),
      content: contents[i] || "",
    }))
    .filter((f) => f.filename && f.content);

  if (files.length === 0) {
    return c.text("At least one file is required", 400);
  }

  try {
    const [row] = await db
      .select()
      .from(gists)
      .where(eq(gists.slug, slug))
      .limit(1);
    if (!row || row.ownerId !== user.id) {
      return c.redirect("/gists");
    }
    // Replace file set: delete all, re-insert.
    await db.delete(gistFiles).where(eq(gistFiles.gistId, row.id));
    await db.insert(gistFiles).values(
      files.map((f) => ({
        gistId: row.id,
        filename: f.filename,
        content: f.content,
        sizeBytes: new TextEncoder().encode(f.content).length,
      }))
    );
    // Bump revision.
    const [last] = await db
      .select({ r: sql<number>`max(${gistRevisions.revision})` })
      .from(gistRevisions)
      .where(eq(gistRevisions.gistId, row.id));
    const nextRev = Number(last?.r || 0) + 1;
    await db.insert(gistRevisions).values({
      gistId: row.id,
      revision: nextRev,
      snapshot: snapshotOf(files),
      authorId: user.id,
      message: message || null,
    });
    await db
      .update(gists)
      .set({ description, updatedAt: new Date() })
      .where(eq(gists.id, row.id));
  } catch {
    // swallow
  }
  return c.redirect(`/gists/${slug}`);
});

// Delete
gistRoutes.post("/gists/:slug/delete", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  try {
    const [row] = await db
      .select()
      .from(gists)
      .where(eq(gists.slug, slug))
      .limit(1);
    if (row && row.ownerId === user.id) {
      await db.delete(gists).where(eq(gists.id, row.id));
    }
  } catch {
    // swallow
  }
  return c.redirect("/gists");
});

// Toggle star
gistRoutes.post("/gists/:slug/star", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  try {
    const [row] = await db
      .select()
      .from(gists)
      .where(eq(gists.slug, slug))
      .limit(1);
    if (row && row.ownerId !== user.id) {
      const [existing] = await db
        .select()
        .from(gistStars)
        .where(
          and(
            eq(gistStars.gistId, row.id),
            eq(gistStars.userId, user.id)
          )
        )
        .limit(1);
      if (existing) {
        await db.delete(gistStars).where(eq(gistStars.id, existing.id));
      } else {
        await db.insert(gistStars).values({
          gistId: row.id,
          userId: user.id,
        });
      }
    }
  } catch {
    // swallow
  }
  return c.redirect(`/gists/${slug}`);
});

// Revisions list
gistRoutes.get("/gists/:slug/revisions", softAuth, async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");

  let gist: any = null;
  let revs: any[] = [];
  try {
    const [row] = await db
      .select()
      .from(gists)
      .where(eq(gists.slug, slug))
      .limit(1);
    if (row && (row.isPublic || (user && user.id === row.ownerId))) {
      gist = row;
      revs = await db
        .select({
          r: gistRevisions,
          author: { username: users.username },
        })
        .from(gistRevisions)
        .innerJoin(users, eq(gistRevisions.authorId, users.id))
        .where(eq(gistRevisions.gistId, gist.id))
        .orderBy(desc(gistRevisions.revision));
    }
  } catch {
    // leave null
  }

  if (!gist) return c.html(notFound(user), 404);

  return c.html(
    <Layout title={`${gist.slug} — revisions`} user={user}>
      <h1 style="margin-top: 16px;">
        <a href={`/gists/${slug}`}>{gist.title || slug}</a> — revisions
      </h1>
      <div class="commit-list" style="margin-top: 16px;">
        {revs.map((rv) => (
          <div class="commit-item">
            <div>
              <div class="commit-message">
                <a href={`/gists/${slug}/revisions/${rv.r.revision}`}>
                  <strong>Revision {rv.r.revision}</strong>
                </a>
                {rv.r.message ? ` — ${rv.r.message}` : ""}
              </div>
              <div class="commit-meta">
                by @{rv.author.username}
              </div>
            </div>
            <a
              href={`/gists/${slug}/revisions/${rv.r.revision}`}
              class="commit-sha"
            >
              r{rv.r.revision}
            </a>
          </div>
        ))}
      </div>
    </Layout>
  );
});

// Revision detail
gistRoutes.get(
  "/gists/:slug/revisions/:rev",
  softAuth,
  async (c) => {
    const user = c.get("user");
    const slug = c.req.param("slug");
    const rev = Number(c.req.param("rev"));

    let gist: any = null;
    let snapshot: Record<string, string> | null = null;
    try {
      const [row] = await db
        .select()
        .from(gists)
        .where(eq(gists.slug, slug))
        .limit(1);
      if (row && (row.isPublic || (user && user.id === row.ownerId))) {
        gist = row;
        const [rv] = await db
          .select()
          .from(gistRevisions)
          .where(
            and(
              eq(gistRevisions.gistId, gist.id),
              eq(gistRevisions.revision, rev)
            )
          )
          .limit(1);
        if (rv) {
          try {
            snapshot = JSON.parse(rv.snapshot);
          } catch {
            snapshot = {};
          }
        }
      }
    } catch {
      // leave null
    }

    if (!gist || !snapshot)
      return c.html(notFound(user, "Revision not found"), 404);

    return c.html(
      <Layout title={`${slug} @ r${rev}`} user={user}>
        <h1 style="margin-top: 16px;">
          <a href={`/gists/${slug}`}>{gist.title || slug}</a> @ revision {rev}
        </h1>
        {Object.entries(snapshot).map(([filename, content]) => {
          const { html: highlighted } = highlightCode(content, filename);
          return (
            <div style="margin-top: 16px; border: 1px solid var(--border); border-radius: 6px;">
              <div class="diff-file-header">{filename}</div>
              <div class="blob-code">
                <pre style="margin: 0; padding: 12px; font-size: 13px; line-height: 1.6; overflow-x: auto;">
                  {html([highlighted] as unknown as TemplateStringsArray)}
                </pre>
              </div>
            </div>
          );
        })}
      </Layout>
    );
  }
);

// User's public gists
gistRoutes.get("/:username/gists", softAuth, async (c) => {
  const user = c.get("user");
  const username = c.req.param("username");

  let ownerUser: any = null;
  let rows: any[] = [];
  try {
    const [u] = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (u) {
      ownerUser = u;
      const showPrivate = user && user.id === u.id;
      rows = await db
        .select({
          g: gists,
          fileCount: sql<number>`(SELECT count(*) FROM gist_files WHERE gist_id = ${gists.id})`,
        })
        .from(gists)
        .where(
          showPrivate
            ? eq(gists.ownerId, u.id)
            : and(eq(gists.ownerId, u.id), eq(gists.isPublic, true))
        )
        .orderBy(desc(gists.updatedAt));
    }
  } catch {
    rows = [];
  }

  if (!ownerUser) return c.html(notFound(user, "User not found"), 404);

  return c.html(
    <Layout title={`@${username}'s gists`} user={user}>
      <h1 style="margin-top: 16px;">
        <a href={`/${username}`}>@{username}</a>'s gists
      </h1>
      {rows.length === 0 ? (
        <div class="empty-state">
          <p>No gists yet.</p>
        </div>
      ) : (
        <div class="commit-list" style="margin-top: 16px;">
          {rows.map((r) => (
            <div class="commit-item">
              <div>
                <div class="commit-message">
                  <a href={`/gists/${r.g.slug}`}>
                    <strong>{r.g.title || r.g.slug}</strong>
                  </a>
                  {!r.g.isPublic && <span class="badge">Secret</span>}
                </div>
                <div class="commit-meta">
                  {r.fileCount} file{r.fileCount !== 1 ? "s" : ""}
                  {r.g.description && ` · ${r.g.description}`}
                </div>
              </div>
              <a href={`/gists/${r.g.slug}`} class="commit-sha">
                {r.g.slug}
              </a>
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
});

export default gistRoutes;
