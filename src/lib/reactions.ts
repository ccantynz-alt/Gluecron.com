/**
 * Reactions helper — aggregate + toggle logic over the `reactions` table.
 * Universal target pointer: (targetType, targetId).
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { reactions } from "../db/schema";

export type TargetType = "issue" | "pr" | "issue_comment" | "pr_comment";

export const ALLOWED_TARGETS: TargetType[] = [
  "issue",
  "pr",
  "issue_comment",
  "pr_comment",
];

export type Emoji =
  | "thumbs_up"
  | "thumbs_down"
  | "rocket"
  | "heart"
  | "eyes"
  | "laugh"
  | "hooray"
  | "confused";

export const ALLOWED_EMOJIS: Emoji[] = [
  "thumbs_up",
  "thumbs_down",
  "rocket",
  "heart",
  "eyes",
  "laugh",
  "hooray",
  "confused",
];

export const EMOJI_GLYPH: Record<Emoji, string> = {
  thumbs_up: "\uD83D\uDC4D",
  thumbs_down: "\uD83D\uDC4E",
  rocket: "\uD83D\uDE80",
  heart: "\u2764\uFE0F",
  eyes: "\uD83D\uDC40",
  laugh: "\uD83D\uDE04",
  hooray: "\uD83C\uDF89",
  confused: "\uD83D\uDE15",
};

export function isAllowedEmoji(x: unknown): x is Emoji {
  return typeof x === "string" && (ALLOWED_EMOJIS as string[]).includes(x);
}

export function isAllowedTarget(x: unknown): x is TargetType {
  return typeof x === "string" && (ALLOWED_TARGETS as string[]).includes(x);
}

export type ReactionSummary = {
  emoji: Emoji;
  count: number;
  reactedByMe: boolean;
};

/**
 * Load reaction counts for a single target, + whether current user reacted.
 */
export async function summariseReactions(
  targetType: TargetType,
  targetId: string,
  currentUserId: string | null | undefined
): Promise<ReactionSummary[]> {
  try {
    const rows = await db
      .select({
        emoji: reactions.emoji,
        count: sql<number>`count(*)::int`,
        mine: sql<number>`sum(case when ${reactions.userId} = ${currentUserId || null} then 1 else 0 end)::int`,
      })
      .from(reactions)
      .where(
        and(
          eq(reactions.targetType, targetType),
          eq(reactions.targetId, targetId)
        )
      )
      .groupBy(reactions.emoji);

    return rows
      .filter((r) => isAllowedEmoji(r.emoji))
      .map((r) => ({
        emoji: r.emoji as Emoji,
        count: Number(r.count) || 0,
        reactedByMe: Number(r.mine) > 0,
      }));
  } catch {
    return [];
  }
}

/**
 * Toggle the user's reaction. Returns the new `reactedByMe` state.
 */
export async function toggleReaction(
  userId: string,
  targetType: TargetType,
  targetId: string,
  emoji: Emoji
): Promise<{ added: boolean }> {
  const existing = await db
    .select({ id: reactions.id })
    .from(reactions)
    .where(
      and(
        eq(reactions.userId, userId),
        eq(reactions.targetType, targetType),
        eq(reactions.targetId, targetId),
        eq(reactions.emoji, emoji)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db.delete(reactions).where(eq(reactions.id, existing[0].id));
    return { added: false };
  }

  await db.insert(reactions).values({
    userId,
    targetType,
    targetId,
    emoji,
  });
  return { added: true };
}
