/**
 * Reactions API — toggle + list reactions on issues, PRs, and their comments.
 *
 * POST /api/reactions/:targetType/:targetId/:emoji/toggle
 *   Body-less; auth required. Returns JSON {ok, added, counts}.
 *   If the request accepts text/html (form submission), redirects back.
 *
 * GET /api/reactions/:targetType/:targetId
 *   Returns the emoji -> count summary plus `reactedByMe` for the caller.
 */

import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth, softAuth } from "../middleware/auth";
import {
  isAllowedEmoji,
  isAllowedTarget,
  summariseReactions,
  toggleReaction,
} from "../lib/reactions";

const reactions = new Hono<AuthEnv>();

reactions.use("/api/reactions/*", softAuth);

reactions.get("/api/reactions/:targetType/:targetId", async (c) => {
  const user = c.get("user");
  const { targetType, targetId } = c.req.param();
  if (!isAllowedTarget(targetType)) {
    return c.json({ ok: false, error: "unknown target type" }, 400);
  }
  const rows = await summariseReactions(targetType, targetId, user?.id);
  return c.json({ ok: true, reactions: rows });
});

reactions.post(
  "/api/reactions/:targetType/:targetId/:emoji/toggle",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { targetType, targetId, emoji } = c.req.param();
    if (!isAllowedTarget(targetType)) {
      return c.json({ ok: false, error: "unknown target type" }, 400);
    }
    if (!isAllowedEmoji(emoji)) {
      return c.json({ ok: false, error: "unknown emoji" }, 400);
    }

    try {
      const { added } = await toggleReaction(
        user.id,
        targetType,
        targetId,
        emoji
      );
      const summary = await summariseReactions(targetType, targetId, user.id);

      const accept = c.req.header("accept") || "";
      if (accept.includes("text/html")) {
        const ref = c.req.header("referer");
        return c.redirect(ref || "/");
      }
      return c.json({ ok: true, added, reactions: summary });
    } catch (err) {
      console.error("[reactions] toggle:", err);
      return c.json({ ok: false, error: "server error" }, 500);
    }
  }
);

export default reactions;
