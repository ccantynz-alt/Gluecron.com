/**
 * Block J1 — Dependency graph tests.
 *
 * Parser smokes for each supported ecosystem + auth smokes for routes.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  parsePackageJson,
  parseRequirementsTxt,
  parsePyprojectToml,
  parseGoMod,
  parseCargoToml,
  parseGemfile,
  parseComposerJson,
  parseManifest,
  isManifestPath,
  __internal,
} from "../lib/deps";

describe("deps — isManifestPath", () => {
  it("recognises supported manifests", () => {
    expect(isManifestPath("package.json")).toBe(true);
    expect(isManifestPath("frontend/package.json")).toBe(true);
    expect(isManifestPath("requirements.txt")).toBe(true);
    expect(isManifestPath("pyproject.toml")).toBe(true);
    expect(isManifestPath("go.mod")).toBe(true);
    expect(isManifestPath("Cargo.toml")).toBe(true);
    expect(isManifestPath("Gemfile")).toBe(true);
    expect(isManifestPath("composer.json")).toBe(true);
  });

  it("rejects unrelated files", () => {
    expect(isManifestPath("README.md")).toBe(false);
    expect(isManifestPath("src/index.ts")).toBe(false);
    expect(isManifestPath("package-lock.json")).toBe(false);
  });
});

describe("deps — parsePackageJson", () => {
  it("extracts dependencies and devDependencies", () => {
    const deps = parsePackageJson(
      JSON.stringify({
        dependencies: { hono: "^4.0.0", "drizzle-orm": "0.30.0" },
        devDependencies: { typescript: "^5.0.0" },
        peerDependencies: { react: ">=18" },
      })
    );
    expect(deps).toHaveLength(4);
    const hono = deps.find((d) => d.name === "hono")!;
    expect(hono.ecosystem).toBe("npm");
    expect(hono.versionSpec).toBe("^4.0.0");
    expect(hono.isDev).toBe(false);
    const ts = deps.find((d) => d.name === "typescript")!;
    expect(ts.isDev).toBe(true);
  });

  it("returns empty on bad JSON", () => {
    expect(parsePackageJson("not json")).toEqual([]);
  });

  it("returns empty when no deps", () => {
    expect(parsePackageJson(JSON.stringify({ name: "x", version: "1" }))).toEqual(
      []
    );
  });
});

describe("deps — parseRequirementsTxt", () => {
  it("parses canonical form", () => {
    const deps = parseRequirementsTxt(
      `# comment
requests==2.28.0
Flask>=2.0,<3.0
numpy
pytest  # inline comment`
    );
    const names = deps.map((d) => d.name);
    expect(names).toContain("requests");
    expect(names).toContain("Flask");
    expect(names).toContain("numpy");
    expect(names).toContain("pytest");
    expect(deps.find((d) => d.name === "requests")!.versionSpec).toBe(
      "==2.28.0"
    );
  });

  it("skips blank lines and editable installs", () => {
    const deps = parseRequirementsTxt(
      `
# just a comment
-e git+https://example.com/foo.git#egg=foo
--index-url https://pypi.org/simple/
`
    );
    expect(deps).toHaveLength(0);
  });

  it("handles extras syntax", () => {
    const deps = parseRequirementsTxt("requests[security]==2.0");
    expect(deps[0].name).toBe("requests");
  });
});

describe("deps — parsePyprojectToml", () => {
  it("extracts project.dependencies", () => {
    const deps = parsePyprojectToml(`
[project]
name = "myapp"
dependencies = [
  "requests>=2.0",
  "flask"
]
`);
    const names = deps.map((d) => d.name).sort();
    expect(names).toContain("requests");
    expect(names).toContain("flask");
  });

  it("extracts optional-dependencies as dev", () => {
    const deps = parsePyprojectToml(`
[project.optional-dependencies]
dev = ["pytest", "black"]
`);
    expect(deps.some((d) => d.name === "pytest" && d.isDev)).toBe(true);
  });
});

describe("deps — parseGoMod", () => {
  it("parses require block", () => {
    const deps = parseGoMod(`
module example.com/foo

go 1.21

require (
    github.com/gorilla/mux v1.8.0
    github.com/jackc/pgx/v5 v5.4.3 // indirect
)
`);
    expect(deps.length).toBeGreaterThanOrEqual(2);
    expect(deps.find((d) => d.name === "github.com/gorilla/mux")!.versionSpec)
      .toBe("v1.8.0");
  });
});

describe("deps — parseCargoToml", () => {
  it("parses [dependencies] and [dev-dependencies]", () => {
    const deps = parseCargoToml(`
[package]
name = "myapp"

[dependencies]
serde = "1.0"
tokio = { version = "1.35", features = ["full"] }

[dev-dependencies]
criterion = "0.5"
`);
    const serde = deps.find((d) => d.name === "serde")!;
    expect(serde.versionSpec).toBe("1.0");
    expect(serde.isDev).toBe(false);
    const tokio = deps.find((d) => d.name === "tokio")!;
    expect(tokio.versionSpec).toBe("1.35");
    const criterion = deps.find((d) => d.name === "criterion")!;
    expect(criterion.isDev).toBe(true);
  });
});

describe("deps — parseGemfile", () => {
  it("parses gem lines", () => {
    const deps = parseGemfile(`
source "https://rubygems.org"

gem "rails", "7.0.0"
gem "puma"

group :development, :test do
  gem "rspec"
end
`);
    const rails = deps.find((d) => d.name === "rails")!;
    expect(rails.versionSpec).toBe("7.0.0");
    const rspec = deps.find((d) => d.name === "rspec")!;
    expect(rspec.isDev).toBe(true);
  });
});

describe("deps — parseComposerJson", () => {
  it("parses require + require-dev, skips php", () => {
    const deps = parseComposerJson(
      JSON.stringify({
        require: { php: ">=8.0", "laravel/framework": "^10.0" },
        "require-dev": { phpunit: "^10.0" },
      })
    );
    expect(deps.find((d) => d.name === "php")).toBeUndefined();
    expect(deps.find((d) => d.name === "laravel/framework")).toBeDefined();
    expect(deps.find((d) => d.name === "phpunit")!.isDev).toBe(true);
  });
});

describe("deps — parseManifest (dispatch)", () => {
  it("routes by basename", () => {
    expect(
      parseManifest("frontend/package.json", '{"dependencies":{"x":"1"}}')
    ).toHaveLength(1);
    expect(parseManifest("some/go.mod", "require foo v1")).toHaveLength(1);
    expect(parseManifest("README.md", "# hi")).toHaveLength(0);
  });

  it("swallows parser errors and returns empty", () => {
    expect(parseManifest("package.json", "not-json")).toEqual([]);
  });
});

describe("deps — TOML helpers", () => {
  const { splitTomlSections, splitTomlArrayItems, pythonRequirementToDep } =
    __internal;

  it("splits sections by header", () => {
    const s = splitTomlSections(`[a]
x = 1

[b]
y = 2`);
    expect(s["a"].trim()).toContain("x = 1");
    expect(s["b"].trim()).toContain("y = 2");
  });

  it("splits array items respecting quotes", () => {
    expect(splitTomlArrayItems('"a, b", "c", "d"')).toEqual([
      '"a, b"',
      '"c"',
      '"d"',
    ]);
  });

  it("parses Python requirement specifiers", () => {
    const d = pythonRequirementToDep("requests>=2.0", false)!;
    expect(d.name).toBe("requests");
    expect(d.versionSpec).toBe(">=2.0");
  });
});

describe("deps — route auth", () => {
  it("GET /:owner/:repo/dependencies for unknown repo → 404 or 500", async () => {
    const res = await app.request("/nobody/missing/dependencies");
    // Route is mounted — either 404 (repo missing) or 500 (no DB in test env)
    expect([404, 500]).toContain(res.status);
  });

  it("POST /:owner/:repo/dependencies/reindex without auth → 302 /login", async () => {
    const res = await app.request("/alice/repo/dependencies/reindex", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});
