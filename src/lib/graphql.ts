/**
 * Block G2 — GraphQL mirror of REST.
 *
 * A deliberately-tiny, dependency-free GraphQL-over-HTTP handler. Supports
 * a fixed set of query fields that mirror the existing REST endpoints:
 *
 *   query {
 *     viewer { id username email }
 *     user(username:"...") { id username createdAt repos { id name visibility } }
 *     repository(owner:"...", name:"...") {
 *       id name description visibility starCount forkCount createdAt
 *       owner { id username }
 *       issues(state:"open", limit:20) { id number title state createdAt }
 *       pullRequests(state:"open", limit:20) { id number title state createdAt }
 *     }
 *     search(q:"...", limit:20) { id name ownerUsername }
 *     rateLimit { remaining reset }
 *   }
 *
 * No mutations — callers should use the REST + /api endpoints for writes.
 * This keeps the attack surface small and sidesteps the need for an
 * auth/authz layer beyond softAuth.
 *
 * The parser is a hand-rolled recursive descent over the subset of
 * GraphQL syntax we actually support (selection sets, named fields,
 * string/number/boolean/enum args). It's not a spec-complete parser —
 * it rejects anything it doesn't understand with a friendly error.
 */

import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  issues,
  pullRequests,
  repositories,
  users,
} from "../db/schema";

// ---------- Types ----------

export interface GqlError {
  message: string;
  path?: string[];
}

export interface GqlResponse {
  data?: Record<string, any> | null;
  errors?: GqlError[];
}

type ArgValue = string | number | boolean | null;

interface Field {
  name: string;
  alias?: string;
  args: Record<string, ArgValue>;
  selections: Field[];
}

// ---------- Parser ----------

/** Parses a query. Returns either the top-level selection set or an error. */
export function parseQuery(
  src: string
): { ok: true; fields: Field[] } | { ok: false; error: string } {
  const s = src.trim();
  try {
    const p = new Parser(s);
    p.skipWs();
    // Optional "query" or "query Name" prefix.
    if (p.peekWord() === "query") {
      p.consumeWord("query");
      p.skipWs();
      // optional operation name
      if (p.peek() && /[A-Za-z_]/.test(p.peek()!)) p.readName();
      p.skipWs();
    }
    const fields = p.parseSelectionSet();
    return { ok: true, fields };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

class Parser {
  private i = 0;
  constructor(private src: string) {}

  peek(): string | null {
    return this.i < this.src.length ? this.src[this.i] : null;
  }

  peekWord(): string {
    this.skipWs();
    let j = this.i;
    let out = "";
    while (j < this.src.length && /[A-Za-z_]/.test(this.src[j])) {
      out += this.src[j];
      j++;
    }
    return out;
  }

  consumeWord(expected: string) {
    this.skipWs();
    const w = this.readName();
    if (w !== expected) {
      throw new Error(`expected '${expected}', got '${w}'`);
    }
  }

  readName(): string {
    this.skipWs();
    let out = "";
    while (this.i < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.i])) {
      out += this.src[this.i];
      this.i++;
    }
    if (!out) throw new Error(`expected identifier at ${this.i}`);
    return out;
  }

  expect(ch: string) {
    this.skipWs();
    if (this.src[this.i] !== ch) {
      throw new Error(`expected '${ch}' at ${this.i}, got '${this.src[this.i] || "EOF"}'`);
    }
    this.i++;
  }

  skipWs() {
    while (
      this.i < this.src.length &&
      /[\s,]/.test(this.src[this.i])
    )
      this.i++;
    // Line comments (#)
    if (this.src[this.i] === "#") {
      while (this.i < this.src.length && this.src[this.i] !== "\n") this.i++;
      this.skipWs();
    }
  }

  parseSelectionSet(): Field[] {
    this.skipWs();
    this.expect("{");
    const out: Field[] = [];
    while (true) {
      this.skipWs();
      if (this.peek() === "}") {
        this.i++;
        return out;
      }
      out.push(this.parseField());
    }
  }

  parseField(): Field {
    this.skipWs();
    const first = this.readName();
    let alias: string | undefined;
    let name = first;
    this.skipWs();
    if (this.peek() === ":") {
      this.i++;
      alias = first;
      name = this.readName();
    }
    this.skipWs();
    const args: Record<string, ArgValue> = {};
    if (this.peek() === "(") {
      this.i++;
      while (true) {
        this.skipWs();
        if (this.peek() === ")") {
          this.i++;
          break;
        }
        const argName = this.readName();
        this.skipWs();
        this.expect(":");
        const val = this.parseValue();
        args[argName] = val;
      }
    }
    this.skipWs();
    let selections: Field[] = [];
    if (this.peek() === "{") {
      selections = this.parseSelectionSet();
    }
    return { name, alias, args, selections };
  }

  parseValue(): ArgValue {
    this.skipWs();
    const ch = this.peek();
    if (ch === '"') {
      this.i++;
      let out = "";
      while (this.i < this.src.length && this.src[this.i] !== '"') {
        if (this.src[this.i] === "\\") {
          this.i++;
          out += this.src[this.i];
        } else {
          out += this.src[this.i];
        }
        this.i++;
      }
      this.expect('"');
      return out;
    }
    // number
    if (ch && /[0-9-]/.test(ch)) {
      let out = "";
      while (this.i < this.src.length && /[0-9.-]/.test(this.src[this.i])) {
        out += this.src[this.i];
        this.i++;
      }
      return Number(out);
    }
    // boolean / null / enum
    const w = this.readName();
    if (w === "true") return true;
    if (w === "false") return false;
    if (w === "null") return null;
    return w; // enum-ish
  }
}

// ---------- Executor ----------

type Resolver = (
  args: Record<string, ArgValue>,
  sel: Field[],
  ctx: ExecCtx
) => Promise<any>;

export interface ExecCtx {
  user: { id: string; username?: string } | null;
}

async function resolveSelections(
  obj: Record<string, any>,
  selections: Field[]
): Promise<Record<string, any>> {
  if (!obj || selections.length === 0) return obj;
  const out: Record<string, any> = {};
  for (const s of selections) {
    const key = s.alias || s.name;
    const val = obj[s.name];
    if (val == null) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(val)) {
      out[key] = val.map((v) =>
        typeof v === "object" ? resolveSelections(v, s.selections) : v
      );
      // Awaits inside map are wrapped individually above (resolveSelections
      // returns a promise only if we call it async). Normalise here:
      out[key] = await Promise.all(
        val.map((v) =>
          typeof v === "object"
            ? resolveSelections(v, s.selections)
            : Promise.resolve(v)
        )
      );
    } else if (typeof val === "object") {
      out[key] = await resolveSelections(val, s.selections);
    } else {
      out[key] = val;
    }
  }
  return out;
}

const ROOT: Record<string, Resolver> = {
  viewer: async (_args, sel, ctx) => {
    if (!ctx.user) return null;
    const [u] = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);
    return u ? resolveSelections(u, sel) : null;
  },

  user: async (args, sel, _ctx) => {
    const username = String(args.username || "");
    if (!username) return null;
    const [u] = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (!u) return null;
    const needsRepos = sel.some((s) => s.name === "repos");
    let repos: any[] = [];
    if (needsRepos) {
      repos = await db
        .select({
          id: repositories.id,
          name: repositories.name,
          isPrivate: repositories.isPrivate,
          starCount: repositories.starCount,
          createdAt: repositories.createdAt,
        })
        .from(repositories)
        .where(
          and(
            eq(repositories.ownerId, u.id),
            eq(repositories.isPrivate, false)
          )
        )
        .orderBy(desc(repositories.createdAt))
        .limit(100);
    }
    return resolveSelections({ ...u, repos }, sel);
  },

  repository: async (args, sel, _ctx) => {
    const owner = String(args.owner || "");
    const name = String(args.name || "");
    if (!owner || !name) return null;
    const [r] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        description: repositories.description,
        isPrivate: repositories.isPrivate,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
        createdAt: repositories.createdAt,
        ownerId: repositories.ownerId,
        ownerUsername: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, name)))
      .limit(1);
    if (!r || r.isPrivate) return null;

    const payload: Record<string, any> = {
      ...r,
      owner: { id: r.ownerId, username: r.ownerUsername },
    };

    const issuesSel = sel.find((s) => s.name === "issues");
    if (issuesSel) {
      const state = String(issuesSel.args.state || "open");
      const limit = Math.min(100, Number(issuesSel.args.limit || 20));
      payload.issues = await db
        .select({
          id: issues.id,
          number: issues.number,
          title: issues.title,
          state: issues.state,
          createdAt: issues.createdAt,
        })
        .from(issues)
        .where(
          and(eq(issues.repositoryId, r.id), eq(issues.state, state))
        )
        .orderBy(desc(issues.createdAt))
        .limit(limit);
    }

    const prSel = sel.find((s) => s.name === "pullRequests");
    if (prSel) {
      const state = String(prSel.args.state || "open");
      const limit = Math.min(100, Number(prSel.args.limit || 20));
      payload.pullRequests = await db
        .select({
          id: pullRequests.id,
          number: pullRequests.number,
          title: pullRequests.title,
          state: pullRequests.state,
          createdAt: pullRequests.createdAt,
        })
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, r.id),
            eq(pullRequests.state, state)
          )
        )
        .orderBy(desc(pullRequests.createdAt))
        .limit(limit);
    }

    return resolveSelections(payload, sel);
  },

  search: async (args, sel, _ctx) => {
    const q = String(args.q || "").trim();
    if (!q) return [];
    const limit = Math.min(50, Number(args.limit || 20));
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerUsername: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(
        and(
          eq(repositories.isPrivate, false),
          or(
            ilike(repositories.name, `%${q}%`),
            ilike(repositories.description, `%${q}%`)
          )!
        )
      )
      .limit(limit);
    return Promise.all(rows.map((r) => resolveSelections(r, sel)));
  },

  rateLimit: async (_args, _sel, _ctx) => {
    // GraphQL doesn't share the REST rate-limit state directly. Surface a
    // permissive synthetic window so clients can consume the shape.
    return { remaining: 1000, reset: Math.floor(Date.now() / 1000) + 3600 };
  },
};

export async function execute(
  src: string,
  ctx: ExecCtx
): Promise<GqlResponse> {
  const parsed = parseQuery(src);
  if (!parsed.ok) {
    return { errors: [{ message: parsed.error }] };
  }
  const out: Record<string, any> = {};
  const errors: GqlError[] = [];
  for (const field of parsed.fields) {
    const resolver = ROOT[field.name];
    const key = field.alias || field.name;
    if (!resolver) {
      errors.push({
        message: `Unknown root field '${field.name}'`,
        path: [key],
      });
      out[key] = null;
      continue;
    }
    try {
      const raw = await resolver(field.args, field.selections, ctx);
      if (raw == null) {
        out[key] = null;
        continue;
      }
      if (Array.isArray(raw)) {
        out[key] = await Promise.all(
          raw.map((v) =>
            typeof v === "object"
              ? resolveSelections(v, field.selections)
              : Promise.resolve(v)
          )
        );
      } else if (typeof raw === "object") {
        // resolver may already have expanded object to selection set; if not,
        // do it now.
        out[key] = await resolveSelections(raw, field.selections);
      } else {
        out[key] = raw;
      }
    } catch (err) {
      errors.push({
        message: (err as Error).message || "execution error",
        path: [key],
      });
      out[key] = null;
    }
  }
  const response: GqlResponse = { data: out };
  if (errors.length > 0) response.errors = errors;
  return response;
}
