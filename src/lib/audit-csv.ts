/**
 * Block J26 — Audit log CSV export helpers.
 *
 * Pure, IO-free functions for serialising audit rows to RFC 4180-compliant CSV
 * with CSV-injection mitigation on untrusted cell content.
 *
 * Injection mitigation: a cell whose first character is `=`, `+`, `-`, `@`,
 * tab, or CR is prefixed with a single quote so spreadsheet formula engines
 * won't evaluate it. The prefix is visible in the resulting cell but is
 * preferable to RCE on double-click in Excel / Sheets.
 *
 * RFC 4180 rules implemented:
 *   - Rows are CRLF-terminated.
 *   - Cells containing `,`, `"`, `\n`, or `\r` are wrapped in double quotes.
 *   - Internal `"` is escaped by doubling: `"` → `""`.
 *   - A cell that needs injection-prefixing and also contains any quoting
 *     trigger is still quoted correctly (prefix goes INSIDE the quotes).
 *   - A leading BOM is NOT emitted — consumers who need Excel-compatibility
 *     can prepend `\uFEFF` themselves.
 */
export const CSV_INJECTION_CHARS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Quote a single cell value. Returns a string ready to be joined into a CSV
 * row. `null`/`undefined` becomes an empty cell. Objects are `String(...)`'d
 * (callers should pre-serialise JSON blobs themselves).
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (value instanceof Date) {
    s = Number.isNaN(value.getTime()) ? "" : value.toISOString();
  } else if (typeof value === "string") {
    s = value;
  } else {
    s = String(value);
  }

  // CSV injection guard — prefix with `'` when the cell starts with a
  // spreadsheet-formula trigger. Must happen before quoting so the prefix
  // lives inside the quoted region.
  if (s.length > 0 && CSV_INJECTION_CHARS.has(s[0]!)) {
    s = "'" + s;
  }

  const needsQuoting =
    s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r");
  if (!needsQuoting) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Join cells with `,`, terminate with CRLF (RFC 4180). */
export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(",") + "\r\n";
}

/** Assemble a full CSV document from an array of row arrays. */
export function csvDocument(rows: readonly (readonly unknown[])[]): string {
  let out = "";
  for (const r of rows) out += csvRow(r);
  return out;
}

/**
 * Shape of an audit row as written by the live audit UI. Matches the select
 * in `src/routes/audit.tsx`.
 */
export interface AuditCsvRow {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: string | null;
  createdAt: Date | string;
  actor: string | null;
}

export const AUDIT_CSV_COLUMNS = [
  "id",
  "when",
  "actor",
  "action",
  "targetType",
  "targetId",
  "ip",
  "userAgent",
  "metadata",
] as const;

function normaliseCreated(v: Date | string): string {
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? "" : v.toISOString();
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  }
  return "";
}

/**
 * Turn an array of audit rows into a CSV string with a header row. Metadata
 * is written verbatim — callers that store JSON in `metadata` should keep
 * doing so; the cell quoting handles embedded commas and quotes.
 */
export function formatAuditCsv(rows: readonly AuditCsvRow[]): string {
  const body: unknown[][] = [AUDIT_CSV_COLUMNS.slice() as unknown[]];
  for (const r of rows) {
    body.push([
      r.id,
      normaliseCreated(r.createdAt),
      r.actor ?? "",
      r.action,
      r.targetType ?? "",
      r.targetId ?? "",
      r.ip ?? "",
      r.userAgent ?? "",
      r.metadata ?? "",
    ]);
  }
  return csvDocument(body);
}

/**
 * Build a `Content-Disposition: attachment; filename="..."` value for an
 * audit-log download. Scope is a short slug (`"personal"` or `"owner-repo"`).
 */
export function auditCsvFilename(scope: string, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const safeScope = scope.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  const slug = safeScope.length > 0 ? safeScope : "audit";
  return `audit-${slug}-${ts}.csv`;
}

export const __internal = {
  CSV_INJECTION_CHARS,
  csvCell,
  csvRow,
  csvDocument,
  formatAuditCsv,
  auditCsvFilename,
  AUDIT_CSV_COLUMNS,
  normaliseCreated,
};
