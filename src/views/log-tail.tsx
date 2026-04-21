/**
 * LogTail — SSR component that renders a <pre> and streams live workflow-run
 * step-log chunks into it via SSE.
 *
 * The initial <pre> is pre-populated with `fallbackLogs` (the DB row's stored
 * logs blob so a viewer with JS disabled, an unsupported browser, or a
 * blocked SSE endpoint still sees whatever was already persisted). Once the
 * inline script connects to `/live-events/workflow-run-<runId>`, it appends
 * step-log chunks as plain escaped text and reloads the page on run-done so
 * the static view takes over.
 */

import { raw } from "hono/html";
import { liveLogTailScript } from "../lib/sse-client";

export function LogTail(props: {
  runId: string;
  jobId?: string;
  fallbackLogs?: string | null;
  height?: string;
  reloadOnRunDone?: boolean;
}): JSX.Element {
  const elementId = `log-tail-${props.runId}${props.jobId ? "-" + props.jobId : ""}`;
  const topic = `workflow-run-${props.runId}`;
  const script = liveLogTailScript({
    topic,
    targetElementId: elementId,
    jobId: props.jobId,
    onRunDone:
      props.reloadOnRunDone === false ? undefined : "location.reload()",
  });

  return (
    <div>
      <div
        style="display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: var(--bg-tertiary); border-top-left-radius: 6px; border-top-right-radius: 6px; font-size: 11px; color: var(--text-muted); font-family: monospace"
      >
        <span>● live log</span>
        <span id={`${elementId}-status`}>connecting…</span>
      </div>
      <pre
        id={elementId}
        style={`margin: 0; padding: 12px 14px; background: #0b0d0f; color: #c7ccd1; font-size: 12px; line-height: 1.45; overflow: auto; max-height: ${props.height || "480px"}; border-bottom-left-radius: 6px; border-bottom-right-radius: 6px`}
      >
        {props.fallbackLogs || ""}
      </pre>
      <script dangerouslySetInnerHTML={{ __html: script }} />
    </div>
  );
}
