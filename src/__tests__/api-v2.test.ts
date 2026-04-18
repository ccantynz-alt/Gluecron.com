import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import app from "../app";
import { clearRateLimitStore } from "../middleware/rate-limit";

const TEST_REPOS = join(import.meta.dir, "../../.test-repos-api-v2");

beforeAll(async () => {
  process.env.GIT_REPOS_PATH = TEST_REPOS;
  process.env.DATABASE_URL = process.env.DATABASE_URL || "";
  clearRateLimitStore();
  await mkdir(TEST_REPOS, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiUrl(path: string): string {
  if (path === "/") return "/api/v2";
  return `/api/v2${path}`;
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

function bearerHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// 1. API Info endpoint
// ---------------------------------------------------------------------------

describe("API v2 - Info endpoint", () => {
  it("GET /api/v2/ returns 200 with JSON listing all endpoints", async () => {
    const res = await app.request(apiUrl("/"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.name).toBe("gluecron API");
    expect(body.version).toBe("2.0");
    expect(body.endpoints).toBeDefined();
    expect(body.endpoints.users).toBeDefined();
    expect(body.endpoints.repositories).toBeDefined();
    expect(body.endpoints.branches).toBeDefined();
    expect(body.endpoints.commits).toBeDefined();
    expect(body.endpoints.files).toBeDefined();
    expect(body.endpoints.issues).toBeDefined();
    expect(body.endpoints.pullRequests).toBeDefined();
    expect(body.endpoints.stars).toBeDefined();
    expect(body.endpoints.labels).toBeDefined();
    expect(body.endpoints.search).toBeDefined();
    expect(body.endpoints.topics).toBeDefined();
    expect(body.endpoints.webhooks).toBeDefined();
    expect(body.endpoints.activity).toBeDefined();
    expect(body.authentication).toBeDefined();
    expect(body.rateLimit).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. User endpoints
// ---------------------------------------------------------------------------

describe("API v2 - User endpoints", () => {
  it("GET /api/v2/user without auth returns 401", async () => {
    const res = await app.request(apiUrl("/user"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("GET /api/v2/users/nobody returns 404 or 500 (no DB)", async () => {
    const res = await app.request(apiUrl("/users/nobody"));
    expect([404, 500]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// 3. Repository endpoints
// ---------------------------------------------------------------------------

describe("API v2 - Repository endpoints", () => {
  it("POST /api/v2/repos without auth returns 401", async () => {
    const res = await app.request(apiUrl("/repos"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "test-repo" }),
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("GET /api/v2/repos/nobody/nothing returns 404 or 500 (no DB)", async () => {
    const res = await app.request(apiUrl("/repos/nobody/nothing"));
    expect([404, 500]).toContain(res.status);
  });

  it("PATCH /api/v2/repos/nobody/nothing without auth returns 401", async () => {
    const res = await app.request(apiUrl("/repos/nobody/nothing"), {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ description: "updated" }),
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("DELETE /api/v2/repos/nobody/nothing without auth returns 401", async () => {
    const res = await app.request(apiUrl("/repos/nobody/nothing"), {
      method: "DELETE",
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Branch endpoints
// ---------------------------------------------------------------------------

describe("API v2 - Branch endpoints", () => {
  it("GET /api/v2/repos/nobody/nothing/branches returns 404 or 500", async () => {
    const res = await app.request(apiUrl("/repos/nobody/nothing/branches"));
    expect([404, 500]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// 5. Commit endpoints
// ---------------------------------------------------------------------------

describe("API v2 - Commit endpoints", () => {
  it("GET /api/v2/repos/nobody/nothing/commits returns 404 or 500", async () => {
    const res = await app.request(apiUrl("/repos/nobody/nothing/commits"));
    expect([404, 500]).toContain(res.status);
  });

  it("GET /api/v2/repos/nobody/nothing/commits/abc123 returns 404 or 500", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/commits/abc123")
    );
    expect([404, 500]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// 6. Tree / File endpoints
// ---------------------------------------------------------------------------

describe("API v2 - Tree and File endpoints", () => {
  it("GET /api/v2/repos/nobody/nothing/tree/main returns 404 or 500", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/tree/main")
    );
    expect([404, 500]).toContain(res.status);
  });

  it("GET /api/v2/repos/nobody/nothing/contents/README.md returns 404 or 500", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/contents/README.md")
    );
    expect([404, 500]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// 7. Issue endpoints
// ---------------------------------------------------------------------------

describe("API v2 - Issue endpoints", () => {
  it("GET /api/v2/repos/nobody/nothing/issues returns 404 or 500 (no DB)", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/issues")
    );
    expect([404, 500]).toContain(res.status);
  });

  it("POST /api/v2/repos/nobody/nothing/issues without auth returns 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/issues"),
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ title: "Bug report" }),
      }
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Pull Request endpoints
// ---------------------------------------------------------------------------

describe("API v2 - Pull Request endpoints", () => {
  it("GET /api/v2/repos/nobody/nothing/pulls returns 404 or 500 (no DB)", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/pulls")
    );
    expect([404, 500]).toContain(res.status);
  });

  it("POST /api/v2/repos/nobody/nothing/pulls without auth returns 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/pulls"),
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          title: "Feature branch",
          baseBranch: "main",
          headBranch: "feature",
        }),
      }
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 9. Star endpoints
// ---------------------------------------------------------------------------

describe("API v2 - Star endpoints", () => {
  it("PUT /api/v2/repos/nobody/nothing/star without auth returns 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/star"),
      { method: "PUT" }
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("DELETE /api/v2/repos/nobody/nothing/star without auth returns 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/star"),
      { method: "DELETE" }
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 10. Label endpoints
// ---------------------------------------------------------------------------

describe("API v2 - Label endpoints", () => {
  it("GET /api/v2/repos/nobody/nothing/labels returns 404 or 500 (no DB)", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/labels")
    );
    expect([404, 500]).toContain(res.status);
  });

  it("POST /api/v2/repos/nobody/nothing/labels without auth returns 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/labels"),
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "bug", color: "#ff0000" }),
      }
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 11. Search endpoints
// ---------------------------------------------------------------------------

describe("API v2 - Search endpoints", () => {
  it("GET /api/v2/search/repos without query returns 400", async () => {
    const res = await app.request(apiUrl("/search/repos"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain("required");
  });

  it("GET /api/v2/search/repos?q=test returns 200 or 500 (no DB)", async () => {
    const res = await app.request(apiUrl("/search/repos?q=test"));
    expect([200, 500]).toContain(res.status);
  });

  it("GET /api/v2/repos/nobody/nothing/search/code?q=test returns 404 or 500", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/search/code?q=test")
    );
    expect([404, 500]).toContain(res.status);
  });

  it("GET /api/v2/search/repos with empty q returns 400", async () => {
    const res = await app.request(apiUrl("/search/repos?q="));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("GET /api/v2/repos/nobody/nothing/search/code without q returns 400", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/search/code")
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain("required");
  });
});

// ---------------------------------------------------------------------------
// 12. Topic endpoints
// ---------------------------------------------------------------------------

describe("API v2 - Topic endpoints", () => {
  it("GET /api/v2/repos/nobody/nothing/topics returns 404 or 500 (no DB)", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/topics")
    );
    expect([404, 500]).toContain(res.status);
  });

  it("PUT /api/v2/repos/nobody/nothing/topics without auth returns 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/topics"),
      {
        method: "PUT",
        headers: jsonHeaders(),
        body: JSON.stringify({ topics: ["javascript", "web"] }),
      }
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 13. Webhook endpoints
// ---------------------------------------------------------------------------

describe("API v2 - Webhook endpoints", () => {
  it("GET /api/v2/repos/nobody/nothing/webhooks without auth returns 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/webhooks")
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("POST /api/v2/repos/nobody/nothing/webhooks without auth returns 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/webhooks"),
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ url: "https://example.com/hook" }),
      }
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 14. Activity endpoint
// ---------------------------------------------------------------------------

describe("API v2 - Activity endpoint", () => {
  it("GET /api/v2/repos/nobody/nothing/activity returns 404 or 500 (no DB)", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/activity")
    );
    expect([404, 500]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// 15. Rate limiting
// ---------------------------------------------------------------------------

describe("API v2 - Rate limiting", () => {
  it("responses include X-RateLimit-Limit header", async () => {
    const res = await app.request(apiUrl("/"));
    expect(res.status).toBe(200);

    const limitHeader = res.headers.get("X-RateLimit-Limit");
    expect(limitHeader).toBeDefined();
    expect(limitHeader).not.toBeNull();
    expect(parseInt(limitHeader!)).toBeGreaterThan(0);
  });

  it("responses include X-RateLimit-Remaining header", async () => {
    const res = await app.request(apiUrl("/"));
    expect(res.status).toBe(200);

    const remainingHeader = res.headers.get("X-RateLimit-Remaining");
    expect(remainingHeader).toBeDefined();
    expect(remainingHeader).not.toBeNull();
    expect(parseInt(remainingHeader!)).toBeGreaterThanOrEqual(0);
  });

  it("responses include X-RateLimit-Reset header", async () => {
    const res = await app.request(apiUrl("/"));
    expect(res.status).toBe(200);

    const resetHeader = res.headers.get("X-RateLimit-Reset");
    expect(resetHeader).toBeDefined();
    expect(resetHeader).not.toBeNull();
    expect(parseInt(resetHeader!)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 16. Invalid Bearer token
// ---------------------------------------------------------------------------

describe("API v2 - Invalid Bearer token", () => {
  it("GET /api/v2/user with invalid Bearer token returns 401", async () => {
    const res = await app.request(apiUrl("/user"), {
      headers: bearerHeader("invalid-token-that-does-not-exist"),
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("GET /api/v2/user with malformed Bearer header returns 401", async () => {
    const res = await app.request(apiUrl("/user"), {
      headers: bearerHeader(""),
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 17. JSON content type
// ---------------------------------------------------------------------------

describe("API v2 - JSON content type", () => {
  it("API info endpoint returns application/json", async () => {
    const res = await app.request(apiUrl("/"));
    expect(res.status).toBe(200);

    const contentType = res.headers.get("Content-Type");
    expect(contentType).toBeDefined();
    expect(contentType!).toContain("application/json");
  });

  it("401 responses return application/json", async () => {
    const res = await app.request(apiUrl("/user"));
    expect(res.status).toBe(401);

    const contentType = res.headers.get("Content-Type");
    expect(contentType).toBeDefined();
    expect(contentType!).toContain("application/json");
  });

  it("400 responses return application/json", async () => {
    const res = await app.request(apiUrl("/search/repos"));
    expect(res.status).toBe(400);

    const contentType = res.headers.get("Content-Type");
    expect(contentType).toBeDefined();
    expect(contentType!).toContain("application/json");
  });
});

// ---------------------------------------------------------------------------
// 18. Validation - POST /api/v2/repos with auth header but no body fields
// ---------------------------------------------------------------------------

describe("API v2 - Repo creation validation", () => {
  it("POST /api/v2/repos with auth header but no body returns 400 or 401", async () => {
    const res = await app.request(apiUrl("/repos"), {
      method: "POST",
      headers: jsonHeaders(bearerHeader("fake-token-for-validation-test")),
      body: JSON.stringify({}),
    });
    // Without a valid token the auth middleware rejects first (401),
    // but if auth somehow passes, missing name would be 400.
    expect([400, 401]).toContain(res.status);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("POST /api/v2/repos with invalid repo name format should return 400 or 401", async () => {
    const res = await app.request(apiUrl("/repos"), {
      method: "POST",
      headers: jsonHeaders(bearerHeader("fake-token")),
      body: JSON.stringify({ name: "invalid repo name with spaces!" }),
    });
    // Auth rejects first (401), but validates the pattern is checked
    expect([400, 401]).toContain(res.status);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 19. Issue validation - POST issue without title
// ---------------------------------------------------------------------------

describe("API v2 - Issue creation validation", () => {
  it("POST issue without title returns 400 or 401 (auth blocks first without DB)", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/issues"),
      {
        method: "POST",
        headers: jsonHeaders(bearerHeader("fake-token")),
        body: JSON.stringify({ body: "Issue body without title" }),
      }
    );
    // Auth middleware rejects invalid tokens (401).
    // With valid auth, missing title would produce 400.
    expect([400, 401]).toContain(res.status);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("POST issue with empty title returns 400 or 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/issues"),
      {
        method: "POST",
        headers: jsonHeaders(bearerHeader("fake-token")),
        body: JSON.stringify({ title: "", body: "Some body" }),
      }
    );
    expect([400, 401]).toContain(res.status);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe("API v2 - Additional edge cases", () => {
  it("GET /api/v2/users/:username/repos returns 404 or 500 for nonexistent user", async () => {
    const res = await app.request(apiUrl("/users/nobody/repos"));
    expect([404, 500]).toContain(res.status);
  });

  it("PATCH /api/v2/user without auth returns 401", async () => {
    const res = await app.request(apiUrl("/user"), {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ displayName: "New Name" }),
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("GET /api/v2/repos/nobody/nothing/issues/1 returns 404 or 500 (no DB)", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/issues/1")
    );
    expect([404, 500]).toContain(res.status);
  });

  it("GET /api/v2/repos/nobody/nothing/pulls/1 returns 404 or 500 (no DB)", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/pulls/1")
    );
    expect([404, 500]).toContain(res.status);
  });

  it("PATCH /api/v2/repos/nobody/nothing/issues/1 without auth returns 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/issues/1"),
      {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ state: "closed" }),
      }
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("POST /api/v2/repos/nobody/nothing/issues/1/comments without auth returns 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/issues/1/comments"),
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ body: "A comment" }),
      }
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});
