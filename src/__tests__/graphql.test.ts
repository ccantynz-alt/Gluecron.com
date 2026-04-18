/**
 * Block G2 — GraphQL parser + endpoint smoke tests.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { parseQuery, execute } from "../lib/graphql";

describe("graphql — parseQuery", () => {
  it("parses a bare selection set", () => {
    const r = parseQuery("{ viewer { id username } }");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.length).toBe(1);
      expect(r.fields[0].name).toBe("viewer");
      expect(r.fields[0].selections.map((s) => s.name)).toEqual([
        "id",
        "username",
      ]);
    }
  });

  it("parses a query with operation keyword", () => {
    const r = parseQuery("query Foo { rateLimit { remaining } }");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields[0].name).toBe("rateLimit");
    }
  });

  it("parses string args", () => {
    const r = parseQuery('{ user(username:"alice") { id } }');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields[0].args.username).toBe("alice");
    }
  });

  it("parses number + boolean args", () => {
    const r = parseQuery('{ search(q:"x", limit:5) { id } }');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields[0].args.limit).toBe(5);
    }
  });

  it("parses aliases", () => {
    const r = parseQuery("{ me:viewer { id } }");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields[0].name).toBe("viewer");
      expect(r.fields[0].alias).toBe("me");
    }
  });

  it("parses nested selections", () => {
    const r = parseQuery(
      `{ repository(owner:"alice", name:"repo") { owner { username } issues(state:"open", limit:5) { title } } }`
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const repo = r.fields[0];
      expect(repo.name).toBe("repository");
      const owner = repo.selections.find((s) => s.name === "owner");
      expect(owner).toBeDefined();
      expect(owner!.selections.map((s) => s.name)).toEqual(["username"]);
    }
  });

  it("skips comments + commas", () => {
    const r = parseQuery("{ # comment\n viewer, { id, username } }");
    expect(r.ok).toBe(true);
  });

  it("returns an error on malformed input", () => {
    const r = parseQuery("{ viewer {");
    expect(r.ok).toBe(false);
  });
});

describe("graphql — execute", () => {
  it("returns data for rateLimit (no-side-effect field)", async () => {
    const r = await execute("{ rateLimit { remaining reset } }", { user: null });
    expect(r.data).toBeDefined();
    expect(r.data?.rateLimit).toBeDefined();
    expect(typeof r.data?.rateLimit.remaining).toBe("number");
    expect(typeof r.data?.rateLimit.reset).toBe("number");
  });

  it("viewer returns null without auth", async () => {
    const r = await execute("{ viewer { id } }", { user: null });
    expect(r.data?.viewer).toBe(null);
  });

  it("unknown root field → error + null data", async () => {
    const r = await execute("{ bogus { id } }", { user: null });
    expect(r.errors).toBeDefined();
    expect(r.errors![0].message).toContain("bogus");
    expect(r.data?.bogus).toBe(null);
  });

  it("parse error surfaces in errors", async () => {
    const r = await execute("{ viewer {", { user: null });
    expect(r.errors).toBeDefined();
  });

  it("user(username) on nonexistent returns null", async () => {
    const r = await execute(
      '{ user(username:"__zzzz_doesnt_exist") { id } }',
      { user: null }
    );
    expect(r.data?.user).toBe(null);
  });

  it("repository on nonexistent returns null", async () => {
    const r = await execute(
      '{ repository(owner:"__nope", name:"__nope") { id } }',
      { user: null }
    );
    expect(r.data?.repository).toBe(null);
  });
});

describe("graphql — HTTP endpoint", () => {
  it("POST /api/graphql with empty query → 400", async () => {
    const res = await app.request("/api/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/graphql with invalid JSON → 400", async () => {
    const res = await app.request("/api/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/graphql rateLimit query returns JSON", async () => {
    const res = await app.request("/api/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ rateLimit { remaining } }" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.rateLimit.remaining).toBeGreaterThan(0);
  });

  it("GET /api/graphql serves a GraphiQL-lite explorer page", async () => {
    const res = await app.request("/api/graphql");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain("text/html");
    const html = await res.text();
    expect(html).toContain("gluecron");
    expect(html).toContain("/api/graphql");
  });
});
