/**
 * Reactions bar — displays current counts + a "+ react" picker.
 * Works without JavaScript: each emoji is its own POST form.
 */

import type { FC } from "hono/jsx";
import {
  ALLOWED_EMOJIS,
  EMOJI_GLYPH,
  type Emoji,
  type ReactionSummary,
  type TargetType,
} from "../lib/reactions";

export const ReactionsBar: FC<{
  targetType: TargetType;
  targetId: string;
  summaries: ReactionSummary[];
  canReact: boolean;
}> = ({ targetType, targetId, summaries, canReact }) => {
  const byEmoji = new Map<Emoji, ReactionSummary>();
  for (const s of summaries) byEmoji.set(s.emoji, s);

  const action = (emoji: Emoji) =>
    `/api/reactions/${targetType}/${targetId}/${emoji}/toggle`;

  const visible = summaries.filter((s) => s.count > 0);

  return (
    <div class="reactions" data-target={`${targetType}:${targetId}`}>
      {visible.map((s) => (
        <form method="POST" action={action(s.emoji)} style="display: inline">
          <button
            type="submit"
            class={`reaction-btn ${s.reactedByMe ? "active" : ""}`}
            title={s.emoji.replace(/_/g, " ")}
            disabled={!canReact}
          >
            <span>{EMOJI_GLYPH[s.emoji]}</span>
            <span class="reaction-count">{s.count}</span>
          </button>
        </form>
      ))}
      {canReact && (
        <details class="reaction-picker">
          <summary class="reaction-btn" title="Add reaction">
            {"\u271A"}
          </summary>
          <div style="display: flex; gap: 4px; padding: 4px">
            {ALLOWED_EMOJIS.filter((e) => !byEmoji.get(e)?.reactedByMe).map(
              (emoji) => (
                <form method="POST" action={action(emoji)} style="display: inline">
                  <button
                    type="submit"
                    class="reaction-btn"
                    title={emoji.replace(/_/g, " ")}
                  >
                    <span>{EMOJI_GLYPH[emoji]}</span>
                  </button>
                </form>
              )
            )}
          </div>
        </details>
      )}
    </div>
  );
};
