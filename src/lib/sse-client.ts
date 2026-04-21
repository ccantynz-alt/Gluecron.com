/**
 * SSE client helper — builds a plain-JS initialization snippet that can be
 * dropped into an SSR'd view via a <script> tag. Intentionally returns a
 * string (not a function export) so it works without any bundler.
 *
 * The returned snippet:
 *   - opens an EventSource on /live-events/<topic>
 *   - for each message event, parses JSON and calls the user-supplied
 *     formatFn (expected to return an HTML string)
 *   - appends the HTML to the target element
 *   - reconnects with a 1-second backoff on error
 *   - no-ops gracefully if EventSource is not supported
 */

// U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are valid
// whitespace in HTML but not in JS string literals. Referenced via
// String.fromCharCode so we never embed the raw codepoints in source.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/**
 * JSON-encode a value for safe inlining inside an HTML <script> block.
 *
 * Plain JSON.stringify is not sufficient: a string containing "</script>"
 * would break out of the surrounding <script> tag. We additionally escape
 * `<`, `>`, `&`, and U+2028/U+2029 so the result is safe to splice verbatim
 * into server-rendered HTML.
 */
function safeJsonForScript(v: unknown): string {
  return JSON.stringify(v)
    .split("<").join("\\u003C")
    .split(">").join("\\u003E")
    .split("&").join("\\u0026")
    .split(LS).join("\\u2028")
    .split(PS).join("\\u2029");
}

export function liveSubscribeScript(args: {
  /** Topic name, e.g. "repo:abc" or "user:42" */
  topic: string;
  /** id of the DOM element that receives appended event HTML */
  targetElementId: string;
  /** Optional JS function body taking (event) and returning an HTML string.
   *  If omitted, a default escapes the JSON payload as text. */
  formatFn?: string;
}): string {
  const topic = safeJsonForScript(args.topic);
  const targetId = safeJsonForScript(args.targetElementId);
  const formatFnBody =
    args.formatFn ??
    "return '<li>' + String(event && event.data || '').replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c];}) + '</li>';";

  // Keep compact to stay under 2KB.
  return (
    "(function(){try{" +
    "if(typeof EventSource==='undefined')return;" +
    "var t=" + topic + ",id=" + targetId + ";" +
    "var el=document.getElementById(id);if(!el)return;" +
    "function fmt(event){" + formatFnBody + "}" +
    "var es,delay=1000;" +
    "function connect(){" +
    "try{es=new EventSource('/live-events/'+encodeURIComponent(t));}catch(e){setTimeout(connect,delay);return;}" +
    "es.onmessage=function(m){try{var d=JSON.parse(m.data);var h=fmt(d);if(h&&el)el.insertAdjacentHTML('beforeend',h);}catch(e){}};" +
    "es.onerror=function(){try{es.close();}catch(e){}setTimeout(connect,delay);};" +
    "}connect();}catch(e){}})();"
  );
}

/**
 * Live log-tail script: subscribe to a workflow-run topic, append step-log
 * chunks to a <pre>, and auto-close when 'run-done' arrives.
 *
 * Unlike liveSubscribeScript, this helper distinguishes SSE event types
 * (step-log / step-start / step-done / run-done) and writes plain text
 * (escaped to prevent HTML injection) into a <pre>. All interpolated
 * option strings are JSON-encoded via safeJsonForScript so that the
 * resulting script fragment is safe to splice into server-rendered HTML.
 */
export function liveLogTailScript(opts: {
  topic: string;
  targetElementId: string;
  jobId?: string;
  onRunDone?: string;
}): string {
  const topic = safeJsonForScript(opts.topic);
  const targetId = safeJsonForScript(opts.targetElementId);
  const jobFilter = safeJsonForScript(opts.jobId ?? "");
  // onRunDone is raw JS supplied by the server. Wrap in try/catch.
  const onRunDone = opts.onRunDone ? String(opts.onRunDone) : "";
  const onRunDoneJson = safeJsonForScript(onRunDone);

  return (
    "(function(){try{" +
    "if(typeof EventSource==='undefined')return;" +
    "var t=" + topic + ",id=" + targetId + ",jf=" + jobFilter + ",onDone=" + onRunDoneJson + ";" +
    "var el=document.getElementById(id);if(!el)return;" +
    "var status=document.getElementById(id+'-status');" +
    "function esc(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c];});}" +
    "function setStatus(s){if(status)status.textContent=s;}" +
    "function scroll(){try{el.scrollTop=el.scrollHeight;}catch(e){}}" +
    "function append(txt){el.insertAdjacentHTML('beforeend',esc(txt));scroll();}" +
    "function match(d){if(!jf)return true;return d&&d.jobId===jf;}" +
    "var es;" +
    "try{es=new EventSource('/live-events/'+encodeURIComponent(t));}catch(e){return;}" +
    "es.addEventListener('open',function(){setStatus('live');});" +
    "es.addEventListener('step-log',function(m){try{var d=JSON.parse(m.data);if(!match(d))return;" +
    "var prefix='[step '+d.stepIndex+' '+(d.stream||'stdout')+'] ';" +
    "var chunk=String(d.chunk==null?'':d.chunk);" +
    "var lines=chunk.split('\\n');" +
    "for(var i=0;i<lines.length;i++){if(i===lines.length-1&&lines[i]==='')continue;append(prefix+lines[i]+'\\n');}" +
    "}catch(e){}});" +
    "es.addEventListener('step-start',function(m){try{var d=JSON.parse(m.data);if(!match(d))return;" +
    "append('>>> step '+d.stepIndex+' ('+(d.name||'')+') started\\n');" +
    "}catch(e){}});" +
    "es.addEventListener('step-done',function(m){try{var d=JSON.parse(m.data);if(!match(d))return;" +
    "var dur=typeof d.durationMs==='number'?(d.durationMs<1000?d.durationMs+'ms':(d.durationMs/1000).toFixed(1)+'s'):'';" +
    "append('<<< step '+d.stepIndex+' done (exit '+d.exitCode+(dur?', '+dur:'')+')\\n');" +
    "}catch(e){}});" +
    "es.addEventListener('run-done',function(m){try{setStatus('done');try{es.close();}catch(e){}if(onDone){try{(new Function(onDone))();}catch(e){}}}catch(e){}});" +
    "es.onerror=function(){setStatus('disconnected');};" +
    "}catch(e){}})();"
  );
}
