/**
 * workflow-conditionals.ts
 *
 * Restricted expression evaluator for workflow `if:` clauses.
 *
 * NO eval(), NO Function constructor. Hand-written tokenizer + recursive-
 * descent / precedence-climbing parser. Never throws on any input.
 *
 * Grammar (lowest precedence first):
 *   or      := and ( '||' and )*
 *   and     := eq  ( '&&' eq )*
 *   eq      := cmp ( ('=='|'!=') cmp )*
 *   cmp     := unary ( ('<'|'<='|'>'|'>=') unary )*
 *   unary   := '!' unary | primary
 *   primary := literal | callOrPath | '(' or ')'
 *   path    := IDENT ( '.' IDENT )*
 *   call    := IDENT '(' [ arg (',' arg)* ] ')'
 */

export type ConditionalContext = {
  env?: Record<string, string>;
  matrix?: Record<string, unknown>;
  steps?: Record<
    string,
    { outcome?: string; conclusion?: string; outputs?: Record<string, string> }
  >;
  needs?: Record<string, { result?: string; outputs?: Record<string, string> }>;
  secrets?: Record<string, string>;
  inputs?: Record<string, unknown>;
  github?: {
    event_name?: string;
    ref?: string;
    sha?: string;
    actor?: string;
    repository?: string;
  };
  job?: { status?: string };
  runner?: { os?: string; arch?: string };
};

export type EvalResult = { ok: true; value: boolean } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Tok =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "ident"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "null" }
  | { k: "op"; v: string }
  | { k: "lparen" }
  | { k: "rparen" }
  | { k: "dot" }
  | { k: "comma" }
  | { k: "eof" };

function tokenize(src: string): Tok[] | { error: string } {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    // whitespace
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // strings
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let s = "";
      let closed = false;
      while (j < n) {
        const ch = src[j]!;
        if (ch === quote) {
          // GitHub Actions uses doubled-quote escape inside single-quoted strings.
          if (quote === "'" && src[j + 1] === "'") {
            s += "'";
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        if (ch === "\\" && quote === '"' && j + 1 < n) {
          const nx = src[j + 1]!;
          if (nx === "n") s += "\n";
          else if (nx === "t") s += "\t";
          else if (nx === "r") s += "\r";
          else if (nx === "\\") s += "\\";
          else if (nx === '"') s += '"';
          else s += nx;
          j += 2;
          continue;
        }
        s += ch;
        j++;
      }
      if (!closed) return { error: `unterminated string at ${i}` };
      toks.push({ k: "str", v: s });
      i = j;
      continue;
    }
    // numbers (integers and simple decimals)
    if ((c >= "0" && c <= "9") || (c === "-" && src[i + 1] && src[i + 1]! >= "0" && src[i + 1]! <= "9")) {
      // Only treat as number if preceded by nothing, an operator, comma, or lparen.
      const prev = toks[toks.length - 1];
      const allowNeg =
        c !== "-" ||
        !prev ||
        prev.k === "op" ||
        prev.k === "comma" ||
        prev.k === "lparen";
      if (c === "-" && !allowNeg) {
        // fall through to operator handling
      } else {
        let j = i;
        if (c === "-") j++;
        while (j < n && src[j]! >= "0" && src[j]! <= "9") j++;
        if (src[j] === "." && src[j + 1] && src[j + 1]! >= "0" && src[j + 1]! <= "9") {
          j++;
          while (j < n && src[j]! >= "0" && src[j]! <= "9") j++;
        }
        const num = Number(src.slice(i, j));
        if (!Number.isFinite(num)) return { error: `bad number at ${i}` };
        toks.push({ k: "num", v: num });
        i = j;
        continue;
      }
    }
    // identifiers / keywords
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
      let j = i + 1;
      while (
        j < n &&
        ((src[j]! >= "a" && src[j]! <= "z") ||
          (src[j]! >= "A" && src[j]! <= "Z") ||
          (src[j]! >= "0" && src[j]! <= "9") ||
          src[j] === "_" ||
          src[j] === "-")
      ) {
        j++;
      }
      const word = src.slice(i, j);
      if (word === "true") toks.push({ k: "bool", v: true });
      else if (word === "false") toks.push({ k: "bool", v: false });
      else if (word === "null") toks.push({ k: "null" });
      else toks.push({ k: "ident", v: word });
      i = j;
      continue;
    }
    // operators / punctuation
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "&&" || two === "||" || two === "<=" || two === ">=") {
      toks.push({ k: "op", v: two });
      i += 2;
      continue;
    }
    if (c === "<" || c === ">") {
      toks.push({ k: "op", v: c });
      i++;
      continue;
    }
    if (c === "!") {
      toks.push({ k: "op", v: "!" });
      i++;
      continue;
    }
    if (c === "(") {
      toks.push({ k: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ k: "rparen" });
      i++;
      continue;
    }
    if (c === ".") {
      toks.push({ k: "dot" });
      i++;
      continue;
    }
    if (c === ",") {
      toks.push({ k: "comma" });
      i++;
      continue;
    }
    return { error: `unexpected character "${c}" at ${i}` };
  }
  toks.push({ k: "eof" });
  return toks;
}

// ---------------------------------------------------------------------------
// AST nodes — represented as tagged unions of plain objects.
// ---------------------------------------------------------------------------

type Node =
  | { t: "lit"; v: unknown }
  | { t: "path"; segs: string[] }
  | { t: "call"; name: string; args: Node[] }
  | { t: "unary"; op: "!"; x: Node }
  | { t: "bin"; op: string; a: Node; b: Node };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  pos = 0;
  constructor(private toks: Tok[]) {}

  peek(): Tok {
    return this.toks[this.pos]!;
  }
  eat(): Tok {
    return this.toks[this.pos++]!;
  }
  expect(k: Tok["k"]): Tok {
    const t = this.eat();
    if (t.k !== k) throw new Error(`expected ${k} got ${t.k}`);
    return t;
  }

  parseOr(): Node {
    let a = this.parseAnd();
    while (this.peek().k === "op" && (this.peek() as { v: string }).v === "||") {
      this.eat();
      const b = this.parseAnd();
      a = { t: "bin", op: "||", a, b };
    }
    return a;
  }
  parseAnd(): Node {
    let a = this.parseEq();
    while (this.peek().k === "op" && (this.peek() as { v: string }).v === "&&") {
      this.eat();
      const b = this.parseEq();
      a = { t: "bin", op: "&&", a, b };
    }
    return a;
  }
  parseEq(): Node {
    let a = this.parseCmp();
    while (this.peek().k === "op") {
      const op = (this.peek() as { v: string }).v;
      if (op !== "==" && op !== "!=") break;
      this.eat();
      const b = this.parseCmp();
      a = { t: "bin", op, a, b };
    }
    return a;
  }
  parseCmp(): Node {
    let a = this.parseUnary();
    while (this.peek().k === "op") {
      const op = (this.peek() as { v: string }).v;
      if (op !== "<" && op !== "<=" && op !== ">" && op !== ">=") break;
      this.eat();
      const b = this.parseUnary();
      a = { t: "bin", op, a, b };
    }
    return a;
  }
  parseUnary(): Node {
    if (this.peek().k === "op" && (this.peek() as { v: string }).v === "!") {
      this.eat();
      return { t: "unary", op: "!", x: this.parseUnary() };
    }
    return this.parsePrimary();
  }
  parsePrimary(): Node {
    const t = this.peek();
    if (t.k === "lparen") {
      this.eat();
      const inner = this.parseOr();
      this.expect("rparen");
      return inner;
    }
    if (t.k === "num") {
      this.eat();
      return { t: "lit", v: t.v };
    }
    if (t.k === "str") {
      this.eat();
      return { t: "lit", v: t.v };
    }
    if (t.k === "bool") {
      this.eat();
      return { t: "lit", v: t.v };
    }
    if (t.k === "null") {
      this.eat();
      return { t: "lit", v: null };
    }
    if (t.k === "ident") {
      this.eat();
      // function call?
      if (this.peek().k === "lparen") {
        this.eat();
        const args: Node[] = [];
        if (this.peek().k !== "rparen") {
          args.push(this.parseOr());
          while (this.peek().k === "comma") {
            this.eat();
            args.push(this.parseOr());
          }
        }
        this.expect("rparen");
        return { t: "call", name: t.v, args };
      }
      // path
      const segs: string[] = [t.v];
      while (this.peek().k === "dot") {
        this.eat();
        const nx = this.eat();
        if (nx.k !== "ident") throw new Error("expected identifier after '.'");
        segs.push(nx.v);
      }
      return { t: "path", segs };
    }
    throw new Error(`unexpected token ${t.k}`);
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

function resolvePath(segs: string[], ctx: ConditionalContext): unknown {
  if (segs.length === 0) return undefined;
  const root = segs[0]!;
  let cur: unknown;
  switch (root) {
    case "env":
      cur = ctx.env ?? {};
      break;
    case "matrix":
      cur = ctx.matrix ?? {};
      break;
    case "steps":
      cur = ctx.steps ?? {};
      break;
    case "needs":
      cur = ctx.needs ?? {};
      break;
    case "secrets":
      cur = ctx.secrets ?? {};
      break;
    case "inputs":
      cur = ctx.inputs ?? {};
      break;
    case "github":
      cur = ctx.github ?? {};
      break;
    case "job":
      cur = ctx.job ?? {};
      break;
    case "runner":
      cur = ctx.runner ?? {};
      break;
    default:
      return undefined;
  }
  for (let i = 1; i < segs.length; i++) {
    if (cur == null) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[segs[i]!];
  }
  return cur;
}

function toBool(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return true;
  if (typeof v === "object") return true;
  return false;
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  // If one side is number and the other is string, compare numerically when possible.
  if (typeof a === "number" && typeof b === "string") {
    const nb = Number(b);
    if (!Number.isNaN(nb)) return a === nb;
    return false;
  }
  if (typeof a === "string" && typeof b === "number") {
    const na = Number(a);
    if (!Number.isNaN(na)) return na === b;
    return false;
  }
  // Case-insensitive string comparison (GitHub Actions semantic).
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  return false;
}

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isNaN(n) ? NaN : n;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v == null) return 0;
  return NaN;
}

function toStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

function evalNode(node: Node, ctx: ConditionalContext): unknown {
  switch (node.t) {
    case "lit":
      return node.v;
    case "path":
      return resolvePath(node.segs, ctx);
    case "unary":
      return !toBool(evalNode(node.x, ctx));
    case "bin": {
      if (node.op === "&&") {
        const av = evalNode(node.a, ctx);
        if (!toBool(av)) return false;
        return toBool(evalNode(node.b, ctx));
      }
      if (node.op === "||") {
        const av = evalNode(node.a, ctx);
        if (toBool(av)) return true;
        return toBool(evalNode(node.b, ctx));
      }
      const a = evalNode(node.a, ctx);
      const b = evalNode(node.b, ctx);
      if (node.op === "==") return looseEq(a, b);
      if (node.op === "!=") return !looseEq(a, b);
      const na = toNum(a);
      const nb = toNum(b);
      if (Number.isNaN(na) || Number.isNaN(nb)) return false;
      if (node.op === "<") return na < nb;
      if (node.op === "<=") return na <= nb;
      if (node.op === ">") return na > nb;
      if (node.op === ">=") return na >= nb;
      return false;
    }
    case "call":
      return evalCall(node, ctx);
  }
}

function evalCall(node: Extract<Node, { t: "call" }>, ctx: ConditionalContext): unknown {
  const name = node.name.toLowerCase();
  const argVals = node.args.map((a) => evalNode(a, ctx));
  switch (name) {
    case "success": {
      const s = ctx.job?.status;
      return s !== "failure" && s !== "cancelled";
    }
    case "failure":
      return ctx.job?.status === "failure";
    case "cancelled":
      return ctx.job?.status === "cancelled";
    case "always":
      return true;
    case "contains": {
      const haystack = argVals[0];
      const needle = argVals[1];
      if (Array.isArray(haystack)) {
        for (const it of haystack) {
          if (looseEq(it, needle)) return true;
        }
        return false;
      }
      const hs = toStr(haystack);
      const nd = toStr(needle);
      if (nd === "") return true;
      return hs.toLowerCase().includes(nd.toLowerCase());
    }
    case "startswith": {
      const s = toStr(argVals[0]).toLowerCase();
      const p = toStr(argVals[1]).toLowerCase();
      return s.startsWith(p);
    }
    case "endswith": {
      const s = toStr(argVals[0]).toLowerCase();
      const p = toStr(argVals[1]).toLowerCase();
      return s.endsWith(p);
    }
    case "format": {
      const fmt = toStr(argVals[0]);
      const rest = argVals.slice(1);
      return fmt.replace(/\{(\d+)\}/g, (_m, idx) => {
        const n = Number(idx);
        if (!Number.isFinite(n) || n < 0 || n >= rest.length) return "";
        return toStr(rest[n]);
      });
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function evaluateIf(
  expr: string | undefined | null,
  ctx: ConditionalContext,
): EvalResult {
  if (expr === undefined || expr === null) return { ok: true, value: true };
  let s = String(expr).trim();
  if (s.length === 0) return { ok: true, value: true };

  // Strip optional ${{ ... }} wrapper if the whole expression is wrapped.
  const m = s.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  if (m && m[1] !== undefined) s = m[1].trim();
  if (s.length === 0) return { ok: true, value: true };

  const toks = tokenize(s);
  if (!Array.isArray(toks)) {
    return { ok: false, error: `parse: ${toks.error}` };
  }

  let ast: Node;
  try {
    const p = new Parser(toks);
    ast = p.parseOr();
    if (p.peek().k !== "eof") {
      return { ok: false, error: `parse: unexpected trailing token ${p.peek().k}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `parse: ${msg}` };
  }

  try {
    const v = evalNode(ast, ctx);
    return { ok: true, value: toBool(v) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `eval: ${msg}` };
  }
}
