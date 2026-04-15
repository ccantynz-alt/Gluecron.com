/**
 * Block J26 — Audit log CSV export. Pure helpers + route smoke tests.
 */

import { describe, it, expect } from "bun:test";
import {
  csvCell,
  csvRow,
  csvDocument,
  formatAuditCsv,
  auditCsvFilename,
  AUDIT_CSV_COLUMNS,
  CSV_INJECTION_CHARS,
  __internal,
  type AuditCsvRow,
} from "../lib/audit-csv";

describe("audit-csv — csvCell", () => {
  it("emits empty string for null/undefined", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("passes through simple strings unchanged", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell("with spaces")).toBe("with spaces");
    expect(csvCell("a/b_c")).toBe("a/b_c");
  });

  it("coerces numbers and booleans via String()", () => {
    expect(csvCell(42)).toBe("42");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(false)).toBe("false");
  });

  it("ISO-serialises Date objects", () => {
    const d = new Date("2025-04-01T12:34:56.789Z");
    expect(csvCell(d)).toBe("2025-04-01T12:34:56.789Z");
  });

  it("treats invalid Date as empty", () => {
    expect(csvCell(new Date("not-a-date"))).toBe("");
  });

  it("quotes cells that contain commas", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
  });

  it("quotes cells that contain newlines", () => {
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
  });

  it("quotes cells that contain a CR on its own (the injection char still leads, gets prefixed)", () => {
    // `\r` is both an injection trigger AND a quote trigger — expected behaviour:
    // prefix `'`, then quote the whole cell.
    expect(csvCell("\rboom")).toBe(`"'\rboom"`);
  });

  it("escapes embedded double quotes", () => {
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('""')).toBe('""""""');
  });

  it("CSV-injection guard prefixes leading =", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
  });

  it("CSV-injection guard + quote trigger combine correctly", () => {
    // leading = AND an embedded comma → prefix lives inside the quotes
    expect(csvCell("=1,2")).toBe(`"'=1,2"`);
  });

  it("CSV-injection guard prefixes leading +", () => {
    expect(csvCell("+1234")).toBe("'+1234");
  });

  it("CSV-injection guard prefixes leading -", () => {
    expect(csvCell("-5")).toBe("'-5");
  });

  it("CSV-injection guard prefixes leading @", () => {
    expect(csvCell("@name")).toBe("'@name");
  });

  it("CSV-injection guard prefixes leading tab", () => {
    expect(csvCell("\tdata")).toBe("'\tdata");
  });

  it("does NOT prefix for benign leading chars", () => {
    expect(csvCell("!bang")).toBe("!bang");
    expect(csvCell("#hash")).toBe("#hash");
    expect(csvCell("a=1")).toBe("a=1"); // equals not at position 0
    expect(csvCell(" leading-space")).toBe(" leading-space");
  });

  it("handles Unicode without mangling", () => {
    expect(csvCell("héllo 🚀")).toBe("héllo 🚀");
  });

  it("empty string stays empty", () => {
    expect(csvCell("")).toBe("");
  });

  it("exposes the trigger set for documentation/testing", () => {
    expect(CSV_INJECTION_CHARS.has("=")).toBe(true);
    expect(CSV_INJECTION_CHARS.has("+")).toBe(true);
    expect(CSV_INJECTION_CHARS.has("-")).toBe(true);
    expect(CSV_INJECTION_CHARS.has("@")).toBe(true);
    expect(CSV_INJECTION_CHARS.has("\t")).toBe(true);
    expect(CSV_INJECTION_CHARS.has("\r")).toBe(true);
    expect(CSV_INJECTION_CHARS.has("a")).toBe(false);
    expect(CSV_INJECTION_CHARS.has("=")).toBe(true);
  });
});

describe("audit-csv — csvRow", () => {
  it("joins cells with comma and terminates with CRLF", () => {
    expect(csvRow(["a", "b", "c"])).toBe("a,b,c\r\n");
  });

  it("empty array yields just the CRLF", () => {
    expect(csvRow([])).toBe("\r\n");
  });

  it("nulls become empty cells", () => {
    expect(csvRow([null, "x", undefined])).toBe(",x,\r\n");
  });

  it("quotes are applied per-cell", () => {
    expect(csvRow(["a,b", 'c"d', "e"])).toBe('"a,b","c""d",e\r\n');
  });
});

describe("audit-csv — csvDocument", () => {
  it("concatenates rows into a full document", () => {
    expect(
      csvDocument([
        ["a", "b"],
        ["1", "2"],
      ])
    ).toBe("a,b\r\n1,2\r\n");
  });

  it("empty input yields empty string", () => {
    expect(csvDocument([])).toBe("");
  });
});

describe("audit-csv — formatAuditCsv", () => {
  const sampleRow: AuditCsvRow = {
    id: "aud_1",
    action: "branch.rename",
    targetType: "branch",
    targetId: "refs/heads/old",
    ip: "203.0.113.1",
    userAgent: "Mozilla/5.0",
    metadata: '{"from":"old","to":"new"}',
    createdAt: new Date("2025-04-01T12:00:00.000Z"),
    actor: "alice",
  };

  it("writes header row exactly once", () => {
    const csv = formatAuditCsv([sampleRow]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "id,when,actor,action,targetType,targetId,ip,userAgent,metadata"
    );
  });

  it("writes a single data row after the header", () => {
    const csv = formatAuditCsv([sampleRow]);
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      'aud_1,2025-04-01T12:00:00.000Z,alice,branch.rename,branch,refs/heads/old,203.0.113.1,Mozilla/5.0,"{""from"":""old"",""to"":""new""}"'
    );
  });

  it("empty rows array still writes the header", () => {
    const csv = formatAuditCsv([]);
    expect(csv).toBe(
      "id,when,actor,action,targetType,targetId,ip,userAgent,metadata\r\n"
    );
  });

  it("nullable fields become empty cells", () => {
    const row: AuditCsvRow = {
      id: "x",
      action: "login",
      targetType: null,
      targetId: null,
      ip: null,
      userAgent: null,
      metadata: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      actor: null,
    };
    const csv = formatAuditCsv([row]);
    const dataLine = csv.split("\r\n")[1]!;
    expect(dataLine).toBe("x,2025-01-01T00:00:00.000Z,,login,,,,,");
  });

  it("accepts string dates and normalises to ISO", () => {
    const row: AuditCsvRow = {
      ...sampleRow,
      createdAt: "2025-04-01T12:00:00Z",
    };
    const csv = formatAuditCsv([row]);
    expect(csv).toContain("2025-04-01T12:00:00.000Z");
  });

  it("keeps unparseable string createdAt verbatim", () => {
    const row: AuditCsvRow = {
      ...sampleRow,
      createdAt: "not-a-date",
    };
    const csv = formatAuditCsv([row]);
    // Appears as a plain cell, not quoted (no commas/quotes/newlines).
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines[1]).toContain(",not-a-date,");
  });

  it("CSV-injection-guards formula-like actor names", () => {
    const row: AuditCsvRow = { ...sampleRow, actor: "=cmd|evil" };
    const csv = formatAuditCsv([row]);
    // actor cell needs both quoting (pipe is fine — but quote is needed because
    // of the prefix + `|`? No — `|` isn't a trigger). Just prefix `'`.
    // However since actor contains no `,"` newline, we only see the prefix.
    expect(csv).toContain(",'=cmd|evil,");
  });

  it("exposes canonical column list", () => {
    expect(AUDIT_CSV_COLUMNS).toEqual([
      "id",
      "when",
      "actor",
      "action",
      "targetType",
      "targetId",
      "ip",
      "userAgent",
      "metadata",
    ]);
  });

  it("each row has exactly 9 cells (commas outside quoted regions)", () => {
    const tricky: AuditCsvRow = {
      id: "aud_tricky",
      action: "x",
      targetType: "t",
      targetId: "id",
      ip: "1.1.1.1",
      userAgent: "mx, browser",
      metadata: '{"a":"b,c"}',
      createdAt: new Date("2025-04-01T00:00:00Z"),
      actor: "name,with,commas",
    };
    const csv = formatAuditCsv([tricky]);
    const dataLine = csv.split("\r\n")[1]!;
    // Strip out quoted regions then count commas — must be exactly 8.
    const stripped = dataLine.replace(/"[^"]*"/g, "X");
    expect(stripped.match(/,/g)?.length).toBe(8);
  });
});

describe("audit-csv — auditCsvFilename", () => {
  it("slug + ISO timestamp form", () => {
    const fn = auditCsvFilename("personal", new Date("2025-04-01T12:00:00Z"));
    expect(fn).toBe("audit-personal-2025-04-01T12-00-00-000Z.csv");
  });

  it("sanitises arbitrary scope strings", () => {
    const fn = auditCsvFilename(
      "alice/repo?bad",
      new Date("2025-04-01T00:00:00Z")
    );
    expect(fn).toMatch(/^audit-alice-repo-bad-2025-04-01T00-00-00-000Z\.csv$/);
  });

  it("falls back to 'audit' on empty or all-bad scope", () => {
    const fn = auditCsvFilename("///", new Date("2025-04-01T00:00:00Z"));
    expect(fn).toBe("audit-audit-2025-04-01T00-00-00-000Z.csv");
  });

  it("uses current time when `now` omitted", () => {
    const fn = auditCsvFilename("personal");
    expect(fn).toMatch(
      /^audit-personal-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.csv$/
    );
  });
});

describe("audit-csv — routes", () => {
  it("GET /settings/audit.csv returns 302 when unauthenticated", async () => {
    const { default: app } = await import("../app");
    const res = await app.request("/settings/audit.csv");
    // requireAuth redirects to /login for unauthenticated web requests.
    expect([302, 401, 403]).toContain(res.status);
  });

  it("GET /:owner/:repo/settings/audit.csv is guarded (never 500)", async () => {
    const { default: app } = await import("../app");
    const res = await app.request("/alice/repo/settings/audit.csv");
    expect([302, 401, 403, 404]).toContain(res.status);
  });
});

describe("audit-csv — __internal parity", () => {
  it("re-exports helpers", () => {
    expect(__internal.csvCell).toBe(csvCell);
    expect(__internal.csvRow).toBe(csvRow);
    expect(__internal.csvDocument).toBe(csvDocument);
    expect(__internal.formatAuditCsv).toBe(formatAuditCsv);
    expect(__internal.auditCsvFilename).toBe(auditCsvFilename);
    expect(__internal.AUDIT_CSV_COLUMNS).toBe(AUDIT_CSV_COLUMNS);
    expect(__internal.CSV_INJECTION_CHARS).toBe(CSV_INJECTION_CHARS);
    expect(typeof __internal.normaliseCreated).toBe("function");
  });
});
