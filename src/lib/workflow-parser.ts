/**
 * Minimal GitHub-Actions-compatible workflow YAML parser.
 *
 * Block C1. Pure function — no DB, no file I/O, no external calls.
 * Input: YAML text. Output: normalised workflow object, or error.
 *
 * Supported subset:
 *   name: <scalar>
 *   on: <scalar> | [list] | { mapping }     (mapping is flattened to its top-level keys)
 *   jobs:
 *     <job-key>:
 *       runs-on: <scalar>                   (default "default")
 *       steps:
 *         - run: <scalar>                   (auto-name "Run command")
 *         - name: <scalar>
 *           run: <scalar>
 *
 * Quirks handled:
 *   - `#` comments (end-of-line and full-line)
 *   - Block literal strings (`|` and `>`) with indentation-stripped bodies
 *   - Inline flow arrays: [a, b, "c, still c"]
 *   - Inline flow mappings: { push: { branches: [main] } }
 *   - Single- and double-quoted scalars
 *   - Extra fields on jobs/steps (env, uses, with, matrix, …) are accepted and ignored
 *   - Job key order is preserved (Map-based accumulation)
 *   - Never throws — bad input returns { ok: false, error }
 */

export type WorkflowStep = {
  name: string;
  run: string;
};

export type WorkflowJob = {
  name: string;
  runsOn: string;
  steps: WorkflowStep[];
};

export type ParsedWorkflow = {
  name: string;
  on: string[];
  /**
   * Cron expressions captured from `on: { schedule: [{cron: "..."}, ...] }`.
   * Empty when the workflow has no schedule trigger (the common case).
   * Strings are passed through verbatim — validation happens later when
   * the scheduler tries to parse them via `src/lib/cron.ts`.
   */
  schedules?: string[];
  jobs: WorkflowJob[];
};

export type ParseResult =
  | { ok: true; workflow: ParsedWorkflow }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Tokeniser: split into logical lines, strip comments, record indent.
// ---------------------------------------------------------------------------

type Line = {
  indent: number;
  text: string; // comment-stripped, right-trimmed
  raw: string; // original (for block-literal body preservation)
  lineNo: number; // 1-based
};

function lex(source: string): Line[] {
  const out: Line[] = [];
  const rawLines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? "";
    // Compute indent (expand tabs as 1 space — we disallow tabs for YAML indent anyway)
    let indent = 0;
    while (indent < raw.length && (raw[indent] === " " || raw[indent] === "\t")) {
      indent++;
    }
    const body = raw.slice(indent);
    // Skip pure blank / pure comment lines
    if (body.length === 0 || body.startsWith("#")) continue;
    // Strip trailing comment (respecting quotes)
    const stripped = stripTrailingComment(body).replace(/\s+$/, "");
    if (stripped.length === 0) continue;
    out.push({ indent, text: stripped, raw, lineNo: i + 1 });
  }
  return out;
}

function stripTrailingComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && inDouble) {
      i++;
      continue;
    }
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble) {
      // Must be preceded by whitespace (or start of line) to count as a comment
      if (i === 0 || /\s/.test(s[i - 1]!)) return s.slice(0, i);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Scalar + flow-value parsing.
// ---------------------------------------------------------------------------

function unquote(s: string): string {
  s = s.trim();
  if (s.length >= 2) {
    if (s.startsWith('"') && s.endsWith('"')) {
      return s
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    if (s.startsWith("'") && s.endsWith("'")) {
      return s.slice(1, -1).replace(/''/g, "'");
    }
  }
  return s;
}

/**
 * Parse a flow-style value starting at `s[i]`. Returns the parsed JS value
 * and the index just after it. Supports nested [..] and {..}, quoted strings,
 * plain scalars, and comma separators.
 */
function parseFlow(s: string, i: number): { value: unknown; next: number } {
  i = skipWs(s, i);
  if (i >= s.length) return { value: "", next: i };
  const c = s[i];
  if (c === "[") return parseFlowSeq(s, i);
  if (c === "{") return parseFlowMap(s, i);
  if (c === '"' || c === "'") {
    const end = findQuoteEnd(s, i);
    return { value: unquote(s.slice(i, end + 1)), next: end + 1 };
  }
  // plain scalar — read until , ] } or end
  let j = i;
  while (j < s.length && s[j] !== "," && s[j] !== "]" && s[j] !== "}") j++;
  return { value: unquote(s.slice(i, j).trim()), next: j };
}

function parseFlowSeq(s: string, i: number): { value: unknown[]; next: number } {
  // assumes s[i] === '['
  const out: unknown[] = [];
  i++;
  i = skipWs(s, i);
  if (s[i] === "]") return { value: out, next: i + 1 };
  while (i < s.length) {
    const { value, next } = parseFlow(s, i);
    out.push(value);
    i = skipWs(s, next);
    if (s[i] === ",") {
      i++;
      i = skipWs(s, i);
      continue;
    }
    if (s[i] === "]") return { value: out, next: i + 1 };
    break; // malformed — bail out gracefully
  }
  return { value: out, next: i };
}

function parseFlowMap(
  s: string,
  i: number,
): { value: Record<string, unknown>; next: number } {
  // assumes s[i] === '{'
  const out: Record<string, unknown> = {};
  i++;
  i = skipWs(s, i);
  if (s[i] === "}") return { value: out, next: i + 1 };
  while (i < s.length) {
    // key
    let keyEnd = i;
    if (s[i] === '"' || s[i] === "'") keyEnd = findQuoteEnd(s, i) + 1;
    else {
      while (keyEnd < s.length && s[keyEnd] !== ":" && s[keyEnd] !== ",") keyEnd++;
    }
    const key = unquote(s.slice(i, keyEnd).trim());
    i = skipWs(s, keyEnd);
    if (s[i] === ":") {
      i++;
      i = skipWs(s, i);
      const { value, next } = parseFlow(s, i);
      out[key] = value;
      i = skipWs(s, next);
    } else {
      // bare key with no value — treat as true (rare in our subset)
      out[key] = true;
    }
    if (s[i] === ",") {
      i++;
      i = skipWs(s, i);
      continue;
    }
    if (s[i] === "}") return { value: out, next: i + 1 };
    break;
  }
  return { value: out, next: i };
}

function findQuoteEnd(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    if (q === '"' && s[j] === "\\") {
      j += 2;
      continue;
    }
    if (s[j] === q) {
      if (q === "'" && s[j + 1] === "'") {
        j += 2;
        continue;
      }
      return j;
    }
    j++;
  }
  return s.length - 1;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return i;
}

// ---------------------------------------------------------------------------
// Block-scalar (| and >) assembly: consumes continuation lines indented deeper
// than `parentIndent` and joins them per the YAML block-scalar rules.
// ---------------------------------------------------------------------------

function readBlockScalar(
  lines: Line[],
  idx: number,
  parentIndent: number,
  style: "literal" | "folded",
): { text: string; next: number } {
  const parts: string[] = [];
  let blockIndent = -1;
  let i = idx;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent <= parentIndent) break;
    if (blockIndent < 0) blockIndent = line.indent;
    // Use the raw line to preserve inner whitespace but strip the common indent.
    const raw = line.raw;
    const stripped = raw.slice(Math.min(blockIndent, raw.length));
    parts.push(stripped);
    i++;
  }
  const text =
    style === "literal"
      ? parts.join("\n")
      : parts
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
          .join(" ");
  return { text, next: i };
}

// ---------------------------------------------------------------------------
// Block-style YAML parser. Recursive-descent over indented Line[] array.
// Returns a plain JS value (object / array / string).
// ---------------------------------------------------------------------------

type Cursor = { i: number };

function parseBlock(lines: Line[], cur: Cursor, indent: number): unknown {
  if (cur.i >= lines.length) return null;
  const first = lines[cur.i]!;
  if (first.indent < indent) return null;
  if (first.text.startsWith("- ") || first.text === "-") {
    return parseBlockSeq(lines, cur, first.indent);
  }
  return parseBlockMap(lines, cur, first.indent);
}

function parseBlockMap(
  lines: Line[],
  cur: Cursor,
  indent: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  while (cur.i < lines.length) {
    const line = lines[cur.i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      // Shouldn't happen in well-formed input — skip defensively.
      cur.i++;
      continue;
    }
    const { text } = line;
    // Must be "key: …" at this indent.
    const colon = findMapColon(text);
    if (colon < 0) break;
    const key = unquote(text.slice(0, colon).trim());
    const rest = text.slice(colon + 1).trim();
    cur.i++;
    if (rest.length === 0) {
      // value is on following deeper-indented lines (or nothing -> null)
      const child = lines[cur.i];
      if (!child || child.indent <= indent) {
        out[key] = null;
      } else {
        out[key] = parseBlock(lines, cur, child.indent);
      }
    } else if (rest === "|" || rest === "|-" || rest === "|+") {
      const { text: bs, next } = readBlockScalar(lines, cur.i, indent, "literal");
      out[key] = rest === "|-" ? bs.replace(/\n+$/, "") : bs;
      cur.i = next;
    } else if (rest === ">" || rest === ">-" || rest === ">+") {
      const { text: bs, next } = readBlockScalar(lines, cur.i, indent, "folded");
      out[key] = bs;
      cur.i = next;
    } else if (rest.startsWith("[") || rest.startsWith("{")) {
      out[key] = parseFlow(rest, 0).value;
    } else {
      out[key] = unquote(rest);
    }
  }
  return out;
}

function parseBlockSeq(lines: Line[], cur: Cursor, indent: number): unknown[] {
  const out: unknown[] = [];
  while (cur.i < lines.length) {
    const line = lines[cur.i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      cur.i++;
      continue;
    }
    if (!(line.text.startsWith("- ") || line.text === "-")) break;
    const afterDash = line.text === "-" ? "" : line.text.slice(2);
    cur.i++;

    if (afterDash.length === 0) {
      // element is on following deeper-indented lines
      const child = lines[cur.i];
      if (!child || child.indent <= indent) {
        out.push(null);
      } else {
        out.push(parseBlock(lines, cur, child.indent));
      }
      continue;
    }

    // Could be "- key: value" (start of an inline map element) or "- scalar"
    const colon = findMapColon(afterDash);
    if (colon >= 0) {
      // Build a virtual map: first pair from `afterDash`, further pairs from
      // subsequent lines indented at (indent + 2 spaces past the dash).
      const key = unquote(afterDash.slice(0, colon).trim());
      const rest = afterDash.slice(colon + 1).trim();
      const elem: Record<string, unknown> = {};
      const childIndent = indent + 2;
      if (rest.length === 0) {
        const child = lines[cur.i];
        if (child && child.indent > childIndent) {
          elem[key] = parseBlock(lines, cur, child.indent);
        } else {
          elem[key] = null;
        }
      } else if (rest === "|" || rest === "|-" || rest === "|+") {
        const { text: bs, next } = readBlockScalar(
          lines,
          cur.i,
          childIndent - 1,
          "literal",
        );
        elem[key] = rest === "|-" ? bs.replace(/\n+$/, "") : bs;
        cur.i = next;
      } else if (rest === ">" || rest === ">-" || rest === ">+") {
        const { text: bs, next } = readBlockScalar(
          lines,
          cur.i,
          childIndent - 1,
          "folded",
        );
        elem[key] = bs;
        cur.i = next;
      } else if (rest.startsWith("[") || rest.startsWith("{")) {
        elem[key] = parseFlow(rest, 0).value;
      } else {
        elem[key] = unquote(rest);
      }
      // Sibling map keys for the same element: same indent as childIndent.
      while (cur.i < lines.length) {
        const sib = lines[cur.i]!;
        if (sib.indent < childIndent) break;
        if (sib.indent > childIndent) {
          cur.i++;
          continue;
        }
        if (sib.text.startsWith("- ") || sib.text === "-") break;
        const sc = findMapColon(sib.text);
        if (sc < 0) break;
        const sk = unquote(sib.text.slice(0, sc).trim());
        const sr = sib.text.slice(sc + 1).trim();
        cur.i++;
        if (sr.length === 0) {
          const child = lines[cur.i];
          if (child && child.indent > childIndent) {
            elem[sk] = parseBlock(lines, cur, child.indent);
          } else {
            elem[sk] = null;
          }
        } else if (sr === "|" || sr === "|-" || sr === "|+") {
          const { text: bs, next } = readBlockScalar(
            lines,
            cur.i,
            childIndent - 1,
            "literal",
          );
          elem[sk] = sr === "|-" ? bs.replace(/\n+$/, "") : bs;
          cur.i = next;
        } else if (sr === ">" || sr === ">-" || sr === ">+") {
          const { text: bs, next } = readBlockScalar(
            lines,
            cur.i,
            childIndent - 1,
            "folded",
          );
          elem[sk] = bs;
          cur.i = next;
        } else if (sr.startsWith("[") || sr.startsWith("{")) {
          elem[sk] = parseFlow(sr, 0).value;
        } else {
          elem[sk] = unquote(sr);
        }
      }
      out.push(elem);
    } else {
      // plain scalar element
      if (afterDash.startsWith("[") || afterDash.startsWith("{")) {
        out.push(parseFlow(afterDash, 0).value);
      } else {
        out.push(unquote(afterDash));
      }
    }
  }
  return out;
}

/** Locate the ':' that ends a mapping key, skipping quoted sections. */
function findMapColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && inDouble) {
      i++;
      continue;
    }
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ":" && !inSingle && !inDouble) {
      // Must be followed by space, EOL, or be at the very end.
      if (i + 1 >= text.length || text[i + 1] === " " || text[i + 1] === "\t") {
        return i;
      }
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Normalisation: raw YAML value → ParsedWorkflow
// ---------------------------------------------------------------------------

function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function normaliseOn(v: unknown): string[] | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s.length ? [s] : null;
  }
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      const s = asString(item);
      if (s && s.trim().length) out.push(s.trim());
    }
    return out.length ? out : null;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>);
    return keys.length ? keys : null;
  }
  return null;
}

/**
 * Extract cron expressions from the raw `on:` value when it is a mapping
 * containing a `schedule:` key. Returns [] for any other shape so callers
 * can unconditionally read `parsed.schedules ?? []`. Tolerant of:
 *   - schedule: [{cron: "0 * * * *"}, ...]
 *   - schedule: {cron: "0 * * * *"}
 *   - schedule: "0 * * * *"  (legacy, not standard but seen in the wild)
 *
 * Pure helper — exported alongside the existing `__test` bundle.
 */
function extractSchedules(rawOn: unknown): string[] {
  if (!rawOn || typeof rawOn !== "object" || Array.isArray(rawOn)) return [];
  const m = rawOn as Record<string, unknown>;
  const node = m.schedule;
  if (node == null) return [];

  const out: string[] = [];
  const collect = (entry: unknown) => {
    if (typeof entry === "string") {
      const s = entry.trim();
      if (s) out.push(s);
      return;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const cron = (entry as Record<string, unknown>).cron;
      const s = typeof cron === "string" ? cron.trim() : "";
      if (s) out.push(s);
    }
  };

  if (Array.isArray(node)) {
    for (const e of node) collect(e);
  } else {
    collect(node);
  }
  return out;
}

function normaliseStep(
  raw: unknown,
  jobName: string,
): { ok: true; step: WorkflowStep } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `step in job '${jobName}' must be a mapping` };
  }
  const r = raw as Record<string, unknown>;
  const run = asString(r.run);
  if (!run || !run.trim().length) {
    return { ok: false, error: `step in job '${jobName}' missing 'run' command` };
  }
  const nameVal = asString(r.name);
  const name = nameVal && nameVal.trim().length ? nameVal.trim() : "Run command";
  return { ok: true, step: { name, run } };
}

function normaliseJob(
  name: string,
  raw: unknown,
): { ok: true; job: WorkflowJob } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `job '${name}' is not a mapping` };
  }
  const r = raw as Record<string, unknown>;
  const runsOnRaw = asString(r["runs-on"]);
  const runsOn = runsOnRaw && runsOnRaw.trim().length ? runsOnRaw.trim() : "default";
  const stepsRaw = r.steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    return { ok: false, error: `job '${name}' has no steps` };
  }
  const steps: WorkflowStep[] = [];
  for (const s of stepsRaw) {
    const res = normaliseStep(s, name);
    if (!res.ok) return res;
    steps.push(res.step);
  }
  return { ok: true, job: { name, runsOn, steps } };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export function parseWorkflow(yaml: string): ParseResult {
  if (typeof yaml !== "string") {
    return { ok: false, error: "workflow input must be a string" };
  }
  let root: unknown;
  try {
    const lines = lex(yaml);
    if (lines.length === 0) {
      return { ok: false, error: "workflow is empty" };
    }
    const cur: Cursor = { i: 0 };
    root = parseBlock(lines, cur, lines[0]!.indent);
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return { ok: false, error: "workflow root must be a mapping" };
  }
  const doc = root as Record<string, unknown>;

  const nameRaw = asString(doc.name);
  const name = nameRaw && nameRaw.trim().length ? nameRaw.trim() : "(unnamed)";

  if (!("on" in doc) || doc.on == null) {
    return { ok: false, error: "workflow missing 'on' trigger" };
  }
  const on = normaliseOn(doc.on);
  if (!on || on.length === 0) {
    return { ok: false, error: "workflow missing 'on' trigger" };
  }
  const schedules = extractSchedules(doc.on);

  const jobsRaw = doc.jobs;
  if (
    !jobsRaw ||
    typeof jobsRaw !== "object" ||
    Array.isArray(jobsRaw) ||
    Object.keys(jobsRaw as Record<string, unknown>).length === 0
  ) {
    return { ok: false, error: "workflow has no jobs" };
  }

  const jobs: WorkflowJob[] = [];
  // Object.keys preserves insertion order for string keys in modern engines.
  for (const key of Object.keys(jobsRaw as Record<string, unknown>)) {
    const res = normaliseJob(key, (jobsRaw as Record<string, unknown>)[key]);
    if (!res.ok) return res;
    jobs.push(res.job);
  }

  const workflow: ParsedWorkflow = { name, on, jobs };
  if (schedules.length > 0) workflow.schedules = schedules;
  return { ok: true, workflow };
}

/**
 * Test-only export of the schedule extractor. Pure helper, no DB.
 */
export const __test = { extractSchedules };
