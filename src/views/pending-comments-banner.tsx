/**
 * Pending-comments banner — surfaced inline on repo pages (issues list,
 * issue detail, PR list, PR detail, repo home) when the viewer is the
 * repo owner AND there are 1+ comments awaiting moderation.
 *
 * We can't add this to `RepoNav` because that component is locked per
 * the build bible. Living here as a thin functional component lets each
 * page wrapper drop it in below the nav with a single import.
 *
 * Styling is scoped under `.modq-banner-*` so it can't bleed into other
 * surfaces. CSS injected inline once per render — the styles are <1KB
 * and the duplicate-injection cost is irrelevant given how rare the
 * banner appears (only on owner-viewed pages with pending items).
 */

const styles = `
  .modq-banner {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 12px 0 18px;
    padding: 12px 16px;
    border-radius: 10px;
    background: linear-gradient(135deg, rgba(245, 191, 79, 0.14), rgba(220, 130, 47, 0.10));
    border: 1px solid rgba(245, 191, 79, 0.45);
    color: var(--text, #e6edf3);
    font-size: 14px;
    line-height: 1.4;
  }
  .modq-banner-icon {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: rgba(245, 191, 79, 0.20);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    color: #f5bf4f;
  }
  .modq-banner-text { flex: 1 1 auto; }
  .modq-banner-text strong { color: var(--text-strong, #fff); }
  .modq-banner-action {
    flex: 0 0 auto;
    padding: 6px 14px;
    border-radius: 6px;
    background: rgba(245, 191, 79, 0.18);
    color: #f5bf4f;
    border: 1px solid rgba(245, 191, 79, 0.45);
    text-decoration: none;
    font-weight: 600;
    font-size: 13px;
  }
  .modq-banner-action:hover {
    background: rgba(245, 191, 79, 0.30);
    text-decoration: none;
  }
  .modq-pending-badge {
    display: inline-block;
    margin-left: 6px;
    padding: 2px 8px;
    border-radius: 9999px;
    background: rgba(245, 191, 79, 0.18);
    border: 1px solid rgba(245, 191, 79, 0.45);
    color: #f5bf4f;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .modq-comment-pending {
    border-left: 3px solid rgba(245, 191, 79, 0.55) !important;
    background: rgba(245, 191, 79, 0.04);
  }
`;

export function PendingCommentsBanner({
  owner,
  repo,
  count,
}: {
  owner: string;
  repo: string;
  count: number;
}) {
  if (!count || count <= 0) return null;
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="modq-banner" role="status" aria-live="polite">
        <span class="modq-banner-icon" aria-hidden="true">!</span>
        <span class="modq-banner-text">
          <strong>
            {count} comment{count === 1 ? "" : "s"}
          </strong>{" "}
          from non-collaborators {count === 1 ? "is" : "are"} awaiting your
          approval. Review them before they go public.
        </span>
        <a
          class="modq-banner-action"
          href={`/${owner}/${repo}/comments/pending`}
        >
          Review queue
        </a>
      </div>
    </>
  );
}
