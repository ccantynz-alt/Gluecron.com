/**
 * Extended workflow parser — adds matrix / if / needs / uses / with / env /
 * outputs / workflow_dispatch inputs on top of the locked base parser in
 * `workflow-parser.ts`.
 *
 * The base parser is shipped and locked (BUILD_BIBLE §4.3). It silently
 * ignores the extended fields. We never modify it. Instead:
 *   1. Call `parseWorkflow()` for the validated base shape.
 *   2. Walk the same YAML with a line-based indent-aware scanner that
 *      specifically looks for the extended keys under known job/step
 *      blocks.
 *   3. Merge the extensions onto the base jobs/steps by name.
 *
 * Any extension-field failure is captured as a `warnings[]` entry without
 * failing the whole parse — the base workflow is still usable.
 *
 * Pure: no DB, no I/O, no external calls. Never throws.
 */

import { parseWorkflow, type ParsedWorkflow } from "./workflow-parser";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MatrixSpec = {
  axes: Record<string, unknown[]>;
  include?: Record<string, unknown>[];
  exclude?: Record<string, unknown>[];
  failFast?: boolean;
  maxParallel?: number;
};

export type ExtendedStep = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  parallel?: boolean;
  continueOnError?: boolean;
};

export type ExtendedJob = {
  name: string;
  runsOn: string;
  if?: string;
  needs?: string[];
  strategy?: { matrix?: MatrixSpec };
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: ExtendedStep[];
};

export type DispatchInput = {
  type: "string" | "boolean" | "choice" | "number";
  required?: boolean;
  default?: string | boolean | number;
  options?: string[];
  description?: string;
};

export type ExtendedWorkflow = {
  name: string;
  on: string[];
  /** Keyed by input name — shape mirrors GitHub Actions' `on.workflow_dispatch.inputs`. */
  dispatchInputs?: Record<string, DispatchInput>;
  env?: Record<string, string>;
  jobs: ExtendedJob[];
  warnings: string[];
};

export type ExtendedParseResult =
  | { ok: true; workflow: ExtendedWorkflow }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Line-based YAML walker (tolerant — only finds blocks we care about)
// ---------------------------------------------------------------------------

type Line = { indent: number; text: string; raw: string };

function lexLines(source: string): Line[] {
  const out: Line[] = [];
  const raw = source.replace(/\r\n?/g, "\n").split("\n");
  for (const r of raw) {
    let indent = 0;
    while (indent < r.length && (r[indent] === " " || r[indent] === "\t")) indent++;
    const body = r.slice(indent);
    if (body.length === 0 || body.startsWith("#")) continue;
    out.push({ indent, text: body, raw: r });
  }
  return out;
}

/** Parse a scalar that may be quoted, true/false, numeric, or plain. */
function parseScalar(raw: string): string | number | boolean | null {
  const s = raw.trim();
  if (s.length === 0) return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** Parse a flow-style array literal like `[a, b, "c"]` or `[16, 18, 20]`. */
function parseFlowArray(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const body = trimmed.slice(1, -1).trim();
  if (body.length === 0) return [];
  const items: string[] = [];
  let depth = 0;
  let cur = "";
  let inQuote: string | null = null;
  for (const ch of body) {
    if (inQuote) {
      cur += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      cur += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) items.push(cur);
  return items.map((s) => parseScalar(s));
}

/** Given the full line list + start index pointing at "key:", collect every
 *  child line (indent > startIndent). Returns the child sub-array and the
 *  index of the line immediately after the block. */
function collectBlock(
  lines: Line[],
  startIdx: number
): { children: Line[]; nextIdx: number } {
  const startIndent = lines[startIdx].indent;
  const children: Line[] = [];
  let i = startIdx + 1;
  while (i < lines.length && lines[i].indent > startIndent) {
    children.push(lines[i]);
    i++;
  }
  return { children, nextIdx: i };
}

/** Split "key: value" at the first unquoted colon. Returns [key, value] or
 *  null if the line has no colon (value-only — used for list items). */
function splitKV(text: string): [string, string] | null {
  let inQuote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") inQuote = ch;
    else if (ch === ":" && (i + 1 === text.length || /\s|$/.test(text[i + 1] ?? ""))) {
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }
  }
  return null;
}

/** Parse a block-style mapping (each line is `key: value` at the same
 *  indent). Returns a flat Record<string, string>. */
function parseBlockMap(children: Line[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (children.length === 0) return out;
  const baseIndent = children[0].indent;
  for (const ln of children) {
    if (ln.indent !== baseIndent) continue;
    const kv = splitKV(ln.text);
    if (!kv) continue;
    const scalar = parseScalar(kv[1]);
    out[kv[0]] = String(scalar ?? "");
  }
  return out;
}

/** Parse `needs:` which can be a scalar, flow-array, or block list. */
function parseNeeds(valueAfterColon: string, children: Line[]): string[] | undefined {
  const v = valueAfterColon.trim();
  if (v.length > 0) {
    if (v.startsWith("[")) {
      return parseFlowArray(v).map(String);
    }
    return [String(parseScalar(v))];
  }
  const items: string[] = [];
  if (children.length === 0) return undefined;
  const baseIndent = children[0].indent;
  for (const ln of children) {
    if (ln.indent !== baseIndent) continue;
    if (ln.text.startsWith("- ")) {
      items.push(String(parseScalar(ln.text.slice(2))));
    }
  }
  return items.length > 0 ? items : undefined;
}

/** Parse a matrix block. `axes` are any key/value where value is a flow
 *  array or block list. `include`/`exclude` are lists of combo maps. */
function parseMatrix(children: Line[], warnings: string[]): MatrixSpec | undefined {
  if (children.length === 0) return undefined;
  const baseIndent = children[0].indent;
  const spec: MatrixSpec = { axes: {} };
  let i = 0;
  while (i < children.length) {
    const ln = children[i];
    if (ln.indent !== baseIndent) {
      i++;
      continue;
    }
    const kv = splitKV(ln.text);
    if (!kv) {
      i++;
      continue;
    }
    const [key, val] = kv;
    if (key === "include" || key === "exclude") {
      // Collect child list-of-map entries
      const slice: Record<string, unknown>[] = [];
      let j = i + 1;
      let current: Record<string, unknown> | null = null;
      while (j < children.length && children[j].indent > baseIndent) {
        const c = children[j];
        if (c.text.startsWith("- ")) {
          if (current) slice.push(current);
          current = {};
          const inner = c.text.slice(2);
          const innerKv = splitKV(inner);
          if (innerKv) current[innerKv[0]] = parseScalar(innerKv[1]);
        } else if (current) {
          const innerKv = splitKV(c.text);
          if (innerKv) current[innerKv[0]] = parseScalar(innerKv[1]);
        }
        j++;
      }
      if (current) slice.push(current);
      if (key === "include") spec.include = slice;
      else spec.exclude = slice;
      i = j;
      continue;
    }
    if (key === "fail-fast") {
      spec.failFast = val.trim() === "true";
      i++;
      continue;
    }
    if (key === "max-parallel") {
      const n = parseInt(val.trim(), 10);
      if (Number.isFinite(n)) spec.maxParallel = n;
      i++;
      continue;
    }
    // Treat as axis
    if (val.trim().length > 0 && val.trim().startsWith("[")) {
      spec.axes[key] = parseFlowArray(val);
      i++;
    } else if (val.trim().length === 0) {
      // Block list under this axis
      const items: unknown[] = [];
      let j = i + 1;
      while (j < children.length && children[j].indent > baseIndent) {
        const c = children[j];
        if (c.text.startsWith("- ")) items.push(parseScalar(c.text.slice(2)));
        j++;
      }
      spec.axes[key] = items;
      i = j;
    } else {
      warnings.push(`matrix axis '${key}' has unsupported shape`);
      i++;
    }
  }
  return spec;
}

/** Parse `on:` block for workflow_dispatch inputs. */
function extractDispatchInputs(
  lines: Line[],
  warnings: string[]
): { onArray: string[]; dispatchInputs?: Record<string, DispatchInput> } {
  const onArray: string[] = [];
  let dispatchInputs: Record<string, DispatchInput> | undefined;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.indent !== 0) continue;
    const kv = splitKV(ln.text);
    if (!kv || kv[0] !== "on") continue;
    const val = kv[1].trim();
    // Scalar/flow form — base parser already handles these; just populate
    if (val.length > 0) {
      if (val.startsWith("[")) {
        onArray.push(...parseFlowArray(val).map(String));
      } else {
        onArray.push(String(parseScalar(val)));
      }
      break;
    }
    // Block form — children can be scalar events or mappings
    const { children } = collectBlock(lines, i);
    if (children.length === 0) break;
    const baseIndent = children[0].indent;
    for (let j = 0; j < children.length; j++) {
      const c = children[j];
      if (c.indent !== baseIndent) continue;
      if (c.text.startsWith("- ")) {
        onArray.push(String(parseScalar(c.text.slice(2))));
        continue;
      }
      const eventKv = splitKV(c.text);
      if (!eventKv) continue;
      const event = eventKv[0];
      onArray.push(event);
      if (event === "workflow_dispatch" && eventKv[1].trim().length === 0) {
        // Look for nested `inputs:` block
        let k = j + 1;
        while (k < children.length && children[k].indent > baseIndent) {
          const inputsLine = children[k];
          const inputsKv = splitKV(inputsLine.text);
          if (inputsKv && inputsKv[0] === "inputs") {
            dispatchInputs = {};
            let m = k + 1;
            const inputBaseIndent = inputsLine.indent + 2;
            while (m < children.length && children[m].indent >= inputBaseIndent) {
              const nameLine = children[m];
              if (nameLine.indent === inputBaseIndent) {
                const nameKv = splitKV(nameLine.text);
                if (nameKv) {
                  const inp: DispatchInput = { type: "string" };
                  let n = m + 1;
                  while (n < children.length && children[n].indent > nameLine.indent) {
                    const fieldKv = splitKV(children[n].text);
                    if (fieldKv) {
                      const [fk, fv] = fieldKv;
                      if (fk === "type") {
                        const t = String(parseScalar(fv));
                        if (t === "string" || t === "boolean" || t === "choice" || t === "number") {
                          inp.type = t;
                        }
                      } else if (fk === "required") {
                        inp.required = parseScalar(fv) === true;
                      } else if (fk === "default") {
                        const s = parseScalar(fv);
                        if (s !== null) inp.default = s as string | boolean | number;
                      } else if (fk === "description") {
                        inp.description = String(parseScalar(fv));
                      } else if (fk === "options" && fv.trim().startsWith("[")) {
                        inp.options = parseFlowArray(fv).map(String);
                      }
                    }
                    n++;
                  }
                  dispatchInputs[nameKv[0]] = inp;
                  m = n;
                  continue;
                }
              }
              m++;
            }
            k = m;
          } else {
            k++;
          }
        }
      }
    }
    break;
  }
  return { onArray, dispatchInputs };
}

/** Walk job + step blocks and enrich them. Returns a map of jobName →
 *  extension data, which callers merge onto the base workflow. */
function extractJobExtensions(
  lines: Line[],
  warnings: string[]
): {
  workflowEnv?: Record<string, string>;
  jobExts: Map<string, Partial<ExtendedJob>>;
  stepExts: Map<string, ExtendedStep[]>; // jobName → step[] aligned by order
} {
  const jobExts = new Map<string, Partial<ExtendedJob>>();
  const stepExts = new Map<string, ExtendedStep[]>();
  let workflowEnv: Record<string, string> | undefined;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.indent !== 0) continue;
    const kv = splitKV(ln.text);
    if (!kv) continue;

    if (kv[0] === "env" && kv[1].trim().length === 0) {
      const { children, nextIdx } = collectBlock(lines, i);
      workflowEnv = parseBlockMap(children);
      i = nextIdx - 1;
      continue;
    }

    if (kv[0] !== "jobs" || kv[1].trim().length > 0) continue;

    // Walk each job block
    const { children: jobChildren } = collectBlock(lines, i);
    if (jobChildren.length === 0) continue;
    const jobIndent = jobChildren[0].indent;
    let j = 0;
    while (j < jobChildren.length) {
      const jline = jobChildren[j];
      if (jline.indent !== jobIndent) {
        j++;
        continue;
      }
      const jkv = splitKV(jline.text);
      if (!jkv) {
        j++;
        continue;
      }
      const jobName = jkv[0];
      // Absolute index in lines[] for this job header
      const absIdx = lines.indexOf(jline);
      const { children: jobBody, nextIdx: jobNextIdx } = collectBlock(lines, absIdx);
      const ext: Partial<ExtendedJob> = {};
      const steps: ExtendedStep[] = [];
      const jobBodyIndent = jobBody.length > 0 ? jobBody[0].indent : 0;

      let k = 0;
      while (k < jobBody.length) {
        const bline = jobBody[k];
        if (bline.indent !== jobBodyIndent) {
          k++;
          continue;
        }
        const bkv = splitKV(bline.text);
        if (!bkv) {
          k++;
          continue;
        }
        const [bkey, bval] = bkv;
        const bodyAbsIdx = lines.indexOf(bline);
        const { children: bodyChildren, nextIdx: bodyNextIdx } = collectBlock(
          lines,
          bodyAbsIdx
        );

        if (bkey === "if") {
          ext.if = bval.trim().length > 0 ? bval.trim() : undefined;
          k++;
        } else if (bkey === "needs") {
          ext.needs = parseNeeds(bval, bodyChildren);
          k = bodyNextIdx - bodyAbsIdx - 1 + k + 1;
        } else if (bkey === "env" && bval.trim().length === 0) {
          ext.env = parseBlockMap(bodyChildren);
          k += bodyChildren.length + 1;
        } else if (bkey === "outputs" && bval.trim().length === 0) {
          ext.outputs = parseBlockMap(bodyChildren);
          k += bodyChildren.length + 1;
        } else if (bkey === "strategy" && bval.trim().length === 0) {
          for (let s = 0; s < bodyChildren.length; s++) {
            const sline = bodyChildren[s];
            if (sline.indent !== bodyChildren[0].indent) continue;
            const skv = splitKV(sline.text);
            if (skv && skv[0] === "matrix" && skv[1].trim().length === 0) {
              const sAbsIdx = lines.indexOf(sline);
              const { children: matrixChildren } = collectBlock(lines, sAbsIdx);
              const matrix = parseMatrix(matrixChildren, warnings);
              if (matrix) ext.strategy = { matrix };
            }
          }
          k += bodyChildren.length + 1;
        } else if (bkey === "steps" && bval.trim().length === 0) {
          // Walk each step
          let stepIdx = 0;
          let s = 0;
          while (s < bodyChildren.length) {
            const sline = bodyChildren[s];
            if (sline.text.startsWith("- ")) {
              const stepBody: Line[] = [];
              const stepIndent = sline.indent;
              const stepFirst: Line = {
                indent: stepIndent + 2,
                text: sline.text.slice(2),
                raw: sline.raw,
              };
              stepBody.push(stepFirst);
              let t = s + 1;
              while (t < bodyChildren.length && bodyChildren[t].indent > stepIndent) {
                stepBody.push(bodyChildren[t]);
                t++;
              }
              const stepExt: ExtendedStep = {};
              for (let u = 0; u < stepBody.length; u++) {
                const stepLine = stepBody[u];
                const sKv = splitKV(stepLine.text);
                if (!sKv) continue;
                const [sk, sv] = sKv;
                if (sk === "id") stepExt.id = String(parseScalar(sv));
                else if (sk === "name") stepExt.name = String(parseScalar(sv));
                else if (sk === "if") stepExt.if = sv.trim();
                else if (sk === "run") stepExt.run = String(parseScalar(sv));
                else if (sk === "uses") stepExt.uses = String(parseScalar(sv));
                else if (sk === "parallel") stepExt.parallel = parseScalar(sv) === true;
                else if (sk === "continue-on-error")
                  stepExt.continueOnError = parseScalar(sv) === true;
                else if (sk === "with" && sv.trim().length === 0) {
                  // Sub-block at deeper indent
                  const withBody: Line[] = [];
                  let v = u + 1;
                  while (v < stepBody.length && stepBody[v].indent > stepLine.indent) {
                    withBody.push(stepBody[v]);
                    v++;
                  }
                  stepExt.with = parseBlockMap(withBody);
                  u = v - 1;
                } else if (sk === "env" && sv.trim().length === 0) {
                  const envBody: Line[] = [];
                  let v = u + 1;
                  while (v < stepBody.length && stepBody[v].indent > stepLine.indent) {
                    envBody.push(stepBody[v]);
                    v++;
                  }
                  stepExt.env = parseBlockMap(envBody);
                  u = v - 1;
                }
              }
              steps.push(stepExt);
              stepIdx++;
              s = t;
            } else {
              s++;
            }
          }
          k += bodyChildren.length + 1;
        } else {
          k++;
        }
      }

      if (Object.keys(ext).length > 0) jobExts.set(jobName, ext);
      if (steps.length > 0) stepExts.set(jobName, steps);
      j = jobNextIdx - absIdx - 1 + j + 1;
    }
    break;
  }

  return { workflowEnv, jobExts, stepExts };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The base parser requires every step to have a `run:` field. For `uses:`-only
 *  steps (which are legal in GitHub Actions) we inject a no-op `run` so base
 *  parse succeeds; the extended parser then picks up the real `uses:` value. */
function preprocessForBaseParser(yaml: string): string {
  const lines = yaml.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inStepsBlock = false;
  let stepsIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.replace(/^\s+/, "");
    const indent = line.length - trimmed.length;

    if (/^steps\s*:\s*$/.test(trimmed)) {
      inStepsBlock = true;
      stepsIndent = indent;
      out.push(line);
      continue;
    }
    if (inStepsBlock && trimmed.length > 0 && indent <= stepsIndent && !trimmed.startsWith("-")) {
      inStepsBlock = false;
    }

    out.push(line);

    if (inStepsBlock && /^-\s+uses\s*:/.test(trimmed)) {
      // Look ahead to see if this step block already has a run: line
      const stepItemIndent = indent;
      let hasRun = false;
      for (let j = i + 1; j < lines.length; j++) {
        const jline = lines[j];
        const jtrim = jline.replace(/^\s+/, "");
        const jindent = jline.length - jtrim.length;
        if (jtrim.length === 0) continue;
        if (jtrim.startsWith("-") && jindent === stepItemIndent) break;
        if (jindent <= stepItemIndent) break;
        if (/^run\s*:/.test(jtrim)) {
          hasRun = true;
          break;
        }
      }
      if (!hasRun) {
        out.push(`${" ".repeat(indent + 2)}run: ':'`);
      }
    }
  }
  return out.join("\n");
}

export function parseExtended(yaml: string): ExtendedParseResult {
  const base = parseWorkflow(preprocessForBaseParser(yaml));
  if (!base.ok) return base;

  const warnings: string[] = [];
  let extended: ExtendedWorkflow;
  try {
    const lines = lexLines(yaml);
    const { onArray, dispatchInputs } = extractDispatchInputs(lines, warnings);
    const { workflowEnv, jobExts, stepExts } = extractJobExtensions(lines, warnings);

    // Merge onto base — keep base structure but enrich each job with extras
    const mergedOn = onArray.length > 0 ? Array.from(new Set(onArray)) : base.workflow.on;

    const jobs: ExtendedJob[] = base.workflow.jobs.map((baseJob) => {
      const ext = jobExts.get(baseJob.name) ?? {};
      const extendedStepsForJob = stepExts.get(baseJob.name) ?? [];
      const steps: ExtendedStep[] = baseJob.steps.map((bs, idx) => {
        const ext = extendedStepsForJob[idx] ?? {};
        return { name: bs.name, run: bs.run, ...ext };
      });
      return {
        name: baseJob.name,
        runsOn: baseJob.runsOn,
        steps,
        if: ext.if,
        needs: ext.needs,
        strategy: ext.strategy,
        env: ext.env,
        outputs: ext.outputs,
      };
    });

    extended = {
      name: base.workflow.name,
      on: mergedOn,
      dispatchInputs,
      env: workflowEnv,
      jobs,
      warnings,
    };
  } catch (err) {
    // Defensive: if enrichment throws for any reason, return the base as
    // an extended workflow with a single warning — never fail the parse.
    warnings.push(
      `extension-pass error: ${err instanceof Error ? err.message : String(err)}`
    );
    extended = {
      name: base.workflow.name,
      on: base.workflow.on,
      jobs: base.workflow.jobs.map((j) => ({
        name: j.name,
        runsOn: j.runsOn,
        steps: j.steps.map((s) => ({ name: s.name, run: s.run })),
      })),
      warnings,
    };
  }

  return { ok: true, workflow: extended };
}
