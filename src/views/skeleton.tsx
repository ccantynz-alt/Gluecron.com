/**
 * BLOCK O2 — Loading skeleton component.
 *
 * Replaces ad-hoc spinners. Renders N gradient-pulsing rectangles
 * shaped like the eventual content. CSS-only animation that respects
 * prefers-reduced-motion.
 */

import type { FC } from "hono/jsx";

export interface SkeletonProps {
  height?: string;
  width?: string;
  rounded?: boolean;
  count?: number;
  gap?: string;
  ariaLabel?: string;
}

export const Skeleton: FC<SkeletonProps> = ({
  height = "1em",
  width = "100%",
  rounded = false,
  count = 1,
  gap = "8px",
  ariaLabel = "Loading",
}) => {
  const n = Math.max(1, Math.floor(count));
  const bars: number[] = [];
  for (let i = 0; i < n; i++) bars.push(i);
  const radius = rounded ? "9999px" : "6px";
  return (
    <div class="skeleton-stack" role="status" aria-live="polite" aria-busy="true" aria-label={ariaLabel}
         style={`display:flex;flex-direction:column;gap:${gap};width:100%`}>
      {bars.map(() => (
        <div class="skeleton-bar" style={`height:${height};width:${width};border-radius:${radius}`} />
      ))}
      <span class="sr-only">{ariaLabel}</span>
      <style dangerouslySetInnerHTML={{ __html: skeletonCss }} />
    </div>
  );
};

export const SkeletonRow: FC<{ height?: number }> = ({ height = 48 }) => (
  <div class="skeleton-bar"
       style={`height:${height}px;width:100%;border-radius:8px;margin-bottom:8px`}
       aria-hidden="true">
    <style dangerouslySetInnerHTML={{ __html: skeletonCss }} />
  </div>
);

export const SkeletonRepoRow: FC = () => (
  <div class="skeleton-repo-row" style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)">
    <div class="skeleton-bar" style="width:32px;height:32px;border-radius:50%" />
    <div style="flex:1;display:flex;flex-direction:column;gap:6px">
      <div class="skeleton-bar" style="height:14px;width:40%" />
      <div class="skeleton-bar" style="height:11px;width:65%" />
    </div>
    <style dangerouslySetInnerHTML={{ __html: skeletonCss }} />
  </div>
);

export const SkeletonList: FC<{ count?: number; height?: number }> = ({ count = 4 }) => {
  const n = Math.max(1, Math.floor(count));
  const rows: number[] = [];
  for (let i = 0; i < n; i++) rows.push(i);
  return (
    <div class="skeleton-list" role="status" aria-busy="true" aria-live="polite" aria-label="Loading repositories">
      {rows.map(() => (<SkeletonRepoRow />))}
    </div>
  );
};

export const skeletonCss = `
.skeleton-bar { background: linear-gradient(90deg, var(--bg-elevated) 0%, rgba(140,109,255,0.10) 50%, var(--bg-elevated) 100%); background-size: 200% 100%; animation: skeleton-shimmer 1.4s linear infinite; border: 1px solid var(--border); display: block; }
:root[data-theme='light'] .skeleton-bar { background: linear-gradient(90deg, var(--bg-elevated) 0%, rgba(109,77,255,0.10) 50%, var(--bg-elevated) 100%); background-size: 200% 100%; }
@keyframes skeleton-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (prefers-reduced-motion: reduce) { .skeleton-bar { animation: none; } }
`;
