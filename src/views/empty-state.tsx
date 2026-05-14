/**
 * BLOCK O2 — Polished empty-state component.
 *
 * Differs from the legacy `EmptyState` in `src/views/ui.tsx`:
 *   - Strongly typed primary + secondary CTAs as data.
 *   - Gradient-bordered card with icon (SVG/emoji) slot.
 *
 * Used from /dashboard, /explore, /:owner/:repo, /issues, /pulls,
 * /notifications. SSR-only.
 */

import type { FC } from "hono/jsx";
import { html } from "hono/html";

export interface EmptyStateCta { href: string; label: string }
export interface PolishedEmptyStateProps {
  icon?: string;
  title: string;
  body: string;
  primaryCta?: EmptyStateCta;
  secondaryCta?: EmptyStateCta;
  footer?: string;
}

export const EmptyState: FC<PolishedEmptyStateProps> = ({
  icon, title, body, primaryCta, secondaryCta, footer,
}) => {
  const iconHtml = icon ?? defaultIcon();
  return (
    <div class="empty-state-polished" role="status">
      <div class="empty-state-polished-card">
        <div class="empty-state-polished-icon" aria-hidden="true">
          {html([iconHtml] as unknown as TemplateStringsArray)}
        </div>
        <h2 class="empty-state-polished-title">{title}</h2>
        <p class="empty-state-polished-body">{body}</p>
        {(primaryCta || secondaryCta) && (
          <div class="empty-state-polished-actions">
            {primaryCta && (<a href={primaryCta.href} class="btn btn-primary">{primaryCta.label}</a>)}
            {secondaryCta && (<a href={secondaryCta.href} class="btn btn-ghost">{secondaryCta.label}</a>)}
          </div>
        )}
        {footer && <div class="empty-state-polished-footer">{footer}</div>}
      </div>
      <style dangerouslySetInnerHTML={{ __html: emptyStatePolishedCss }} />
    </div>
  );
};

function defaultIcon(): string {
  return `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="es-grad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse"><stop stop-color="#8c6dff"/><stop offset="1" stop-color="#36c5d6"/></linearGradient></defs><path d="M24 4 L28 20 L44 24 L28 28 L24 44 L20 28 L4 24 L20 20 Z" fill="url(#es-grad)" opacity="0.85"/></svg>`;
}

export const emptyStatePolishedCss = `
.empty-state-polished { margin: 24px 0; display: flex; justify-content: center; }
.empty-state-polished-card { position: relative; max-width: 560px; width: 100%; padding: 56px 32px 40px; text-align: center; background: var(--bg-elevated); border-radius: 14px; overflow: hidden; }
.empty-state-polished-card::before { content: ''; position: absolute; inset: 0; padding: 1.5px; border-radius: 14px; background: var(--accent-gradient); -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; pointer-events: none; opacity: 0.55; }
.empty-state-polished-card::after { content: ''; position: absolute; inset: 0; background: radial-gradient(60% 60% at 50% 0%, rgba(140,109,255,0.08), transparent 70%); pointer-events: none; }
.empty-state-polished-card > * { position: relative; z-index: 1; }
.empty-state-polished-icon { display: inline-flex; align-items: center; justify-content: center; margin: 0 auto 16px; font-size: 48px; line-height: 1; }
.empty-state-polished-icon svg { display: block; }
.empty-state-polished-title { font-size: 20px; font-weight: 700; letter-spacing: -0.015em; margin: 0 0 8px; color: var(--text); }
.empty-state-polished-body { font-size: 14px; line-height: 1.6; color: var(--text-muted); max-width: 440px; margin: 0 auto 20px; }
.empty-state-polished-actions { display: inline-flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-bottom: 4px; }
.empty-state-polished-footer { margin-top: 16px; font-size: 12px; color: var(--text-muted); font-family: var(--font-mono); }
`;
