/**
 * Dependency CVE Scanner — unit tests.
 *
 * Tests the pure parsing helpers, the OSV result mapper, and issue-body
 * renderers without touching the DB or network.
 */

import { describe, it, expect } from "bun:test";
import { __internal } from "../lib/dependency-scanner";
import app from "../app";

const {
  parsePackageJson,
  parseRequirementsTxt,
  parseCargoToml,
  parseGoMod,
  parseGemfile,
  mapSeverity,
  extractFixVersion,
  osvResultsToFindings,
  renderVulnIssueBody,
  renderDigestBody,
  WEEKLY_DIGEST_MARKER,
  FILE_ECOSYSTEM,
  DEPENDENCY_FILES,
} = __internal;

// ---------------------------------------------------------------------------
// parsePackageJson
// ---------------------------------------------------------------------------

describe("parsePackageJson", () => {
  it("parses dependencies and devDependencies", () => {
    const json = JSON.stringify({
      dependencies: { lodash: "^4.17.11", express: "^4.18.0" },
      devDependencies: { jest: "^29.0.0" },
    });
    const result = parsePackageJson(json, "npm");
    expect(result.length).toBe(3);
    expect(result.map((p) => p.name)).toContain("lodash");
    expect(result.map((p) => p.name)).toContain("express");
    expect(result.map((p) => p.name)).toContain("jest");
  });

  it("strips leading ^ ~ from version specs", () => {
    const json = JSON.stringify({ dependencies: { react: "^18.2.0" } });
    const result = parsePackageJson(json, "npm");
    expect(result[0].version).toBe("18.2.0");
  });

  it("returns [] on invalid JSON", () => {
    expect(parsePackageJson("not json", "npm")).toEqual([]);
  });

  it("sets correct ecosystem", () => {
    const json = JSON.stringify({ dependencies: { foo: "1.0.0" } });
    const result = parsePackageJson(json, "npm");
    expect(result[0].ecosystem).toBe("npm");
  });

  it("handles empty dependency sections", () => {
    const json = JSON.stringify({ name: "my-app" });
    expect(parsePackageJson(json, "npm")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseRequirementsTxt
// ---------------------------------------------------------------------------

describe("parseRequirementsTxt", () => {
  it("parses pinned versions", () => {
    const content = "requests==2.28.0\nDjango>=4.1\nflask\n";
    const result = parseRequirementsTxt(content, "PyPI");
    expect(result.map((p) => p.name)).toContain("requests");
    expect(result.find((p) => p.name === "requests")?.version).toBe("2.28.0");
    expect(result.map((p) => p.name)).toContain("Django");
    expect(result.map((p) => p.name)).toContain("flask");
  });

  it("skips comments and -r flags", () => {
    const content = "# comment\n-r base.txt\nnumpy==1.24.0\n";
    const result = parseRequirementsTxt(content, "PyPI");
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("numpy");
  });

  it("returns [] for empty content", () => {
    expect(parseRequirementsTxt("", "PyPI")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseCargoToml
// ---------------------------------------------------------------------------

describe("parseCargoToml", () => {
  it("parses simple string versions", () => {
    const content = `[dependencies]\nserde = "1.0.163"\ntokio = "1.28.0"\n`;
    const result = parseCargoToml(content, "crates.io");
    expect(result.map((p) => p.name)).toContain("serde");
    expect(result.find((p) => p.name === "serde")?.version).toBe("1.0.163");
    expect(result.find((p) => p.name === "tokio")?.version).toBe("1.28.0");
  });

  it("parses table-style versions", () => {
    const content = `[dependencies]\nactix-web = { version = "4.3.0", features = ["macros"] }\n`;
    const result = parseCargoToml(content, "crates.io");
    expect(result.find((p) => p.name === "actix-web")?.version).toBe("4.3.0");
  });

  it("skips [package] and other sections", () => {
    const content = `[package]\nname = "my-crate"\n\n[dependencies]\nhyper = "0.14.27"\n`;
    const result = parseCargoToml(content, "crates.io");
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("hyper");
  });

  it("returns [] for empty content", () => {
    expect(parseCargoToml("", "crates.io")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseGoMod
// ---------------------------------------------------------------------------

describe("parseGoMod", () => {
  it("parses require lines", () => {
    const content = `module example.com/myapp\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n\tgolang.org/x/net v0.10.0\n)\n`;
    const result = parseGoMod(content, "Go");
    expect(result.map((p) => p.name)).toContain("github.com/gin-gonic/gin");
    expect(result.find((p) => p.name === "github.com/gin-gonic/gin")?.version).toBe("1.9.0");
  });

  it("strips leading v from version", () => {
    const content = `require github.com/foo/bar v2.1.0\n`;
    const result = parseGoMod(content, "Go");
    expect(result[0].version).toBe("2.1.0");
  });

  it("returns [] for content with no require lines", () => {
    expect(parseGoMod("module foo\n\ngo 1.21\n", "Go")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseGemfile
// ---------------------------------------------------------------------------

describe("parseGemfile", () => {
  it("parses gem declarations", () => {
    const content = `source 'https://rubygems.org'\ngem 'rails', '~> 7.0'\ngem 'pg'\n`;
    const result = parseGemfile(content, "RubyGems");
    expect(result.map((p) => p.name)).toContain("rails");
    expect(result.map((p) => p.name)).toContain("pg");
  });

  it("returns [] for non-gem lines", () => {
    expect(parseGemfile("source 'https://rubygems.org'\n", "RubyGems")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mapSeverity
// ---------------------------------------------------------------------------

describe("mapSeverity", () => {
  it("returns 'critical' for CVSS score >= 9.0", () => {
    expect(
      mapSeverity({ id: "x", severity: [{ type: "CVSS_V3", score: "9.5" }] })
    ).toBe("critical");
  });

  it("returns 'high' for CVSS score >= 7.0", () => {
    expect(
      mapSeverity({ id: "x", severity: [{ type: "CVSS_V3", score: "8.1" }] })
    ).toBe("high");
  });

  it("returns 'medium' for CVSS score >= 4.0", () => {
    expect(
      mapSeverity({ id: "x", severity: [{ type: "CVSS_V3", score: "5.3" }] })
    ).toBe("medium");
  });

  it("returns 'low' for CVSS score < 4.0", () => {
    expect(
      mapSeverity({ id: "x", severity: [{ type: "CVSS_V3", score: "2.1" }] })
    ).toBe("low");
  });

  it("handles string CRITICAL severity", () => {
    expect(
      mapSeverity({ id: "x", severity: [{ type: "CVSS_V3", score: "CRITICAL" }] })
    ).toBe("critical");
  });

  it("handles string HIGH severity", () => {
    expect(
      mapSeverity({ id: "x", severity: [{ type: "CVSS_V3", score: "HIGH" }] })
    ).toBe("high");
  });

  it("returns 'medium' when no severity data", () => {
    expect(mapSeverity({ id: "x" })).toBe("medium");
    expect(mapSeverity({ id: "x", severity: [] })).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// extractFixVersion
// ---------------------------------------------------------------------------

describe("extractFixVersion", () => {
  it("extracts fix version from affected ranges", () => {
    const vuln = {
      id: "CVE-2021-44228",
      affected: [
        {
          ranges: [
            {
              type: "SEMVER",
              events: [{ introduced: "2.0.0" }, { fixed: "2.15.0" }],
            },
          ],
        },
      ],
    };
    expect(extractFixVersion(vuln)).toBe("2.15.0");
  });

  it("returns undefined when no fix is available", () => {
    const vuln = {
      id: "CVE-XXXX",
      affected: [{ ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }] }],
    };
    expect(extractFixVersion(vuln)).toBeUndefined();
  });

  it("returns undefined for vulns with no affected data", () => {
    expect(extractFixVersion({ id: "x" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// osvResultsToFindings
// ---------------------------------------------------------------------------

describe("osvResultsToFindings", () => {
  it("converts OSV results to VulnFindings", () => {
    const packages = [{ name: "lodash", version: "4.17.11", ecosystem: "npm" }];
    const results = [
      {
        vulns: [
          {
            id: "GHSA-p6mc-m468-83gw",
            summary: "Prototype pollution in lodash",
            severity: [{ type: "CVSS_V3", score: "9.8" }],
            affected: [
              {
                ranges: [
                  { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.12" }] },
                ],
              },
            ],
          },
        ],
      },
    ];
    const findings = osvResultsToFindings(packages, results);
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe("lodash");
    expect(findings[0].installedVersion).toBe("4.17.11");
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].cveId).toBe("GHSA-p6mc-m468-83gw");
    expect(findings[0].fixVersion).toBe("4.17.12");
  });

  it("returns [] when no vulns in results", () => {
    const packages = [{ name: "safe-pkg", version: "1.0.0", ecosystem: "npm" }];
    const results = [{ vulns: [] }];
    expect(osvResultsToFindings(packages, results)).toEqual([]);
  });

  it("handles mismatched results length gracefully", () => {
    const packages = [{ name: "pkg-a", version: "1.0.0", ecosystem: "npm" }];
    const findings = osvResultsToFindings(packages, []);
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// renderVulnIssueBody
// ---------------------------------------------------------------------------

describe("renderVulnIssueBody", () => {
  const finding = {
    packageName: "lodash",
    installedVersion: "4.17.11",
    severity: "critical" as const,
    cveId: "GHSA-p6mc-m468-83gw",
    description: "Prototype pollution.",
    fixVersion: "4.17.12",
  };

  it("includes package name and version", () => {
    const body = renderVulnIssueBody(finding);
    expect(body).toContain("lodash");
    expect(body).toContain("4.17.11");
  });

  it("includes CVE ID with OSV link", () => {
    const body = renderVulnIssueBody(finding);
    expect(body).toContain("GHSA-p6mc-m468-83gw");
    expect(body).toContain("https://osv.dev/vulnerability/GHSA-p6mc-m468-83gw");
  });

  it("includes fix version in remediation", () => {
    const body = renderVulnIssueBody(finding);
    expect(body).toContain("4.17.12");
  });

  it("mentions 'No fix' when fixVersion is absent", () => {
    const body = renderVulnIssueBody({ ...finding, fixVersion: undefined });
    expect(body).toContain("No fix version");
  });

  it("includes CRITICAL urgency text for critical severity", () => {
    const body = renderVulnIssueBody(finding);
    expect(body).toContain("CRITICAL");
  });
});

// ---------------------------------------------------------------------------
// renderDigestBody
// ---------------------------------------------------------------------------

describe("renderDigestBody", () => {
  const findings = [
    {
      packageName: "minimist",
      installedVersion: "1.2.0",
      severity: "medium" as const,
      cveId: "CVE-2020-7598",
      description: "Prototype pollution.",
      fixVersion: "1.2.2",
    },
  ];

  it("includes the weekly digest marker", () => {
    expect(renderDigestBody(findings)).toContain(WEEKLY_DIGEST_MARKER);
  });

  it("includes package name and CVE in the table", () => {
    const body = renderDigestBody(findings);
    expect(body).toContain("minimist");
    expect(body).toContain("CVE-2020-7598");
  });

  it("returns valid markdown table", () => {
    const body = renderDigestBody(findings);
    expect(body).toContain("| Package |");
    expect(body).toContain("|---|");
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("DEPENDENCY_FILES contains the five expected files", () => {
    expect(DEPENDENCY_FILES).toContain("package.json");
    expect(DEPENDENCY_FILES).toContain("requirements.txt");
    expect(DEPENDENCY_FILES).toContain("Cargo.toml");
    expect(DEPENDENCY_FILES).toContain("go.mod");
    expect(DEPENDENCY_FILES).toContain("Gemfile");
  });

  it("FILE_ECOSYSTEM maps each file to an ecosystem", () => {
    expect(FILE_ECOSYSTEM["package.json"]).toBe("npm");
    expect(FILE_ECOSYSTEM["requirements.txt"]).toBe("PyPI");
    expect(FILE_ECOSYSTEM["Cargo.toml"]).toBe("crates.io");
    expect(FILE_ECOSYSTEM["go.mod"]).toBe("Go");
    expect(FILE_ECOSYSTEM["Gemfile"]).toBe("RubyGems");
  });
});

// ---------------------------------------------------------------------------
// Route auth smoke tests
// ---------------------------------------------------------------------------

describe("GET /:owner/:repo/security/vulnerabilities — route auth", () => {
  it("returns 404 for non-existent owner", async () => {
    const res = await app.request(
      "/nonexistent-owner-99999/my-repo/security/vulnerabilities"
    );
    expect(res.status).toBe(404);
  });
});
