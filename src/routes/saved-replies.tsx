/**
 * Saved replies — per-user canned comment templates.
 *
 * Routes:
 *   GET  /settings/replies                    list + create form
 *   POST /settings/replies                    create
 *   POST /settings/replies/:id/delete         delete
 *   POST /settings/replies/:id                update
 *   GET  /api/user/replies                    JSON list for the insertion picker
 */

import { Hono } from "hono";
import { and, eq, asc } from "drizzle-orm";
import { db } from "../db";
import { savedReplies } from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";

const replies = new Hono<AuthEnv>();

replies.use("/settings/replies", requireAuth);
replies.use("/settings/replies/*", requireAuth);
replies.use("/api/user/replies", requireAuth);

function trimBounded(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

async function listForUser(userId: string) {
  try {
    return await db
      .select()
      .from(savedReplies)
      .where(eq(savedReplies.userId, userId))
      .orderBy(asc(savedReplies.shortcut));
  } catch (err) {
    console.error("[saved-replies] list:", err);
    return [];
  }
}

replies.get("/settings/replies", async (c) => {
  const user = c.get("user")!;
  const rows = await listForUser(user.id);
  const error = c.req.query("error");
  const success = c.req.query("success");

  return c.html(
    <Layout title="Saved replies" user={user}>
      <div class="settings-container" style="max-width: 720px">
        <h2>Saved replies</h2>
        <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 16px">
          Canned responses you can insert into any issue or PR comment. The
          shortcut is a nickname only you see.
        </p>

        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}

        <form method="post" action="/settings/replies" style="margin-bottom: 24px">
          <div class="form-group">
            <label for="shortcut">Shortcut</label>
            <input
              type="text"
              id="shortcut"
              name="shortcut"
              required
              maxLength={64}
              placeholder="lgtm"
            />
          </div>
          <div class="form-group">
            <label for="body">Reply body</label>
            <textarea
              id="body"
              name="body"
              rows={4}
              required
              maxLength={4096}
              placeholder="LGTM! Thanks for the PR."
              style="font-family: var(--font-mono); font-size: 13px"
            />
          </div>
          <button type="submit" class="btn btn-primary">
            Add saved reply
          </button>
        </form>

        {rows.length > 0 && (
          <div>
            <h3 style="font-size: 16px; margin-bottom: 12px">
              Your replies ({rows.length})
            </h3>
            <div class="saved-replies-list">
              {rows.map((r) => (
                <details class="saved-reply-item">
                  <summary>
                    <code>{r.shortcut}</code>
                    <span style="color: var(--text-muted); font-size: 12px; margin-left: 8px">
                      {r.body.slice(0, 80).replace(/\n/g, " ")}
                      {r.body.length > 80 ? "\u2026" : ""}
                    </span>
                  </summary>
                  <div style="padding: 12px 16px; background: var(--bg-secondary); border-top: 1px solid var(--border)">
                    <form method="post" action={`/settings/replies/${r.id}`}>
                      <div class="form-group">
                        <label>Shortcut</label>
                        <input
                          type="text"
                          name="shortcut"
                          required
                          value={r.shortcut}
                          maxLength={64}
                        />
                      </div>
                      <div class="form-group">
                        <label>Body</label>
                        <textarea
                          name="body"
                          rows={4}
                          required
                          maxLength={4096}
                          style="font-family: var(--font-mono); font-size: 13px"
                        >
                          {r.body}
                        </textarea>
                      </div>
                      <div style="display: flex; gap: 8px">
                        <button type="submit" class="btn btn-primary">
                          Save
                        </button>
                        <button
                          type="submit"
                          formaction={`/settings/replies/${r.id}/delete`}
                          class="btn btn-danger"
                          onclick="return confirm('Delete this saved reply?')"
                        >
                          Delete
                        </button>
                      </div>
                    </form>
                  </div>
                </details>
              ))}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
});

replies.post("/settings/replies", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const shortcut = trimBounded(String(body.shortcut || ""), 64);
  const text = trimBounded(String(body.body || ""), 4096);
  if (!shortcut || !text) {
    return c.redirect(
      "/settings/replies?error=" + encodeURIComponent("Shortcut and body are required")
    );
  }
  try {
    await db.insert(savedReplies).values({
      userId: user.id,
      shortcut,
      body: text,
    });
  } catch (err: any) {
    if (String(err?.message || err).includes("saved_replies_user_shortcut")) {
      return c.redirect(
        "/settings/replies?error=" +
          encodeURIComponent("You already have a reply with that shortcut")
      );
    }
    console.error("[saved-replies] create:", err);
    return c.redirect(
      "/settings/replies?error=" + encodeURIComponent("Failed to save")
    );
  }
  return c.redirect(
    "/settings/replies?success=" + encodeURIComponent("Reply saved")
  );
});

replies.post("/settings/replies/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const shortcut = trimBounded(String(body.shortcut || ""), 64);
  const text = trimBounded(String(body.body || ""), 4096);
  if (!shortcut || !text) {
    return c.redirect(
      "/settings/replies?error=" + encodeURIComponent("Shortcut and body are required")
    );
  }
  try {
    await db
      .update(savedReplies)
      .set({ shortcut, body: text, updatedAt: new Date() })
      .where(and(eq(savedReplies.id, id), eq(savedReplies.userId, user.id)));
  } catch (err) {
    console.error("[saved-replies] update:", err);
  }
  return c.redirect(
    "/settings/replies?success=" + encodeURIComponent("Reply updated")
  );
});

replies.post("/settings/replies/:id/delete", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  try {
    await db
      .delete(savedReplies)
      .where(and(eq(savedReplies.id, id), eq(savedReplies.userId, user.id)));
  } catch (err) {
    console.error("[saved-replies] delete:", err);
  }
  return c.redirect(
    "/settings/replies?success=" + encodeURIComponent("Reply deleted")
  );
});

replies.get("/api/user/replies", async (c) => {
  const user = c.get("user")!;
  const rows = await listForUser(user.id);
  return c.json({
    ok: true,
    replies: rows.map((r) => ({
      id: r.id,
      shortcut: r.shortcut,
      body: r.body,
    })),
  });
});

export default replies;
