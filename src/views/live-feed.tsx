/**
 * LiveFeed — small SSR component that renders an empty <ul> and an inline
 * <script> which subscribes to a server-sent-events topic and appends
 * formatted list items as events arrive.
 *
 * Events on the wire are expected to shape `{action, actor, target}`.
 * If SSE fails or EventSource is unsupported, the <ul> simply stays empty
 * — the rest of the page still renders normally.
 */

import { liveSubscribeScript } from "../lib/sse-client";

export function LiveFeed(props: {
  topic: string;
  title?: string;
}): JSX.Element {
  const title = props.title ?? "Live activity";
  const listId = "live-feed";

  // formatFn is inlined client-side JS. It receives the parsed event payload
  // and returns an HTML string (an <li>). All interpolated values are HTML-
  // escaped to avoid breakout.
  const formatFn = `
    function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
    var d = event && event.data ? event.data : event;
    if (!d) return '';
    return '<li>' + esc(d.actor) + ' ' + esc(d.action) + ' ' + esc(d.target) + '</li>';
  `;

  const script = liveSubscribeScript({
    topic: props.topic,
    targetElementId: listId,
    formatFn,
  });

  return (
    <section
      class="live-feed"
      style="margin-top: 24px; padding: 16px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius)"
    >
      <h3 style="font-size: 14px; margin: 0 0 12px 0; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px">
        {title}
      </h3>
      <ul
        id={listId}
        style="list-style: none; padding: 0; margin: 0; font-size: 13px; color: var(--text)"
      />
      <script dangerouslySetInnerHTML={{ __html: script }} />
    </section>
  );
}
