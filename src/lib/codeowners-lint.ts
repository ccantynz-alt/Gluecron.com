/**
 * Block J21 — CODEOWNERS validator.
 *
 * Pure lint layer for CODEOWNERS files. Splits input line-by-line,
 * classifies each line (comment / blank / rule / malformed), and returns
 * a typed report with errors + warnings anchored to 1-indexed line
 * numbers so the UI can point the user at the exact problem.
 *
 * Validation is *local* (structure + obviously-bogus tokens) except for
 * `unknownUser` / `unknownTeam`, which require a caller-supplied
 * resolver so this module stays IO-free and easy to unit-test.
 */

export type LintSeverity = "error" | "warning" | "info";

export type LintCode =
  | "empty_pattern"
  | "no_owners"
  | "bad_owner_format"
  | "unknown_user"
  | "unknown_team"
  | "duplicate_pattern"
  | "duplicate_owner"
  | "missing_catchall"
  | "empty_file"
  | "bad_pattern_syntax";

export interface LintFinding {
  line: number;
  code: LintCode;
  severity: LintSeverity;
  message: string;
  /** Optional pattern + offending token for the UI to highlight. */
  pattern?: string;
  token?: string;
}

export interface LexedRule {
  line: number;
  /** The raw line text (without trailing `\n`). */
  raw: string;
  pattern: string;
  /** Owner tokens **without** leading `@`, in source order. */
  owners: string[];
}

export interface LintReport {
  totalLines: number;
  totalRules: number;
  rules: LexedRule[];
  findings: LintFinding[];
  errors: LintFinding[];
  warnings: LintFinding[];
  infos: LintFinding[];
  /** Convenience: true iff `errors.length === 0`. */
  ok: boolean;
}

/**
 * Resolver contract — the route fulfils this from the DB / org model so
 * the pure lint logic remains free of external dependencies.
 */
export interface OwnerResolver {
  isUser: (username: string) => boolean | Promise<boolean>;
  isTeam: (org: string, team: string) => boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/**
 * Split content into per-line records. Comment and blank lines are kept
 * in the return only so callers can display the original file alongside
 * findings — they produce no findings themselves.
 */
export function lexCodeowners(content: string): {
  rules: LexedRule[];
  malformedLines: Array<{ line: number; raw: string }>;
  totalLines: number;
} {
  const rules: LexedRule[] = [];
  const malformed: Array<{ line: number; raw: string }> = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const trimmed = raw.replace(/#.*$/, "").trim();
    if (!trimmed) return; // blank or pure comment
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1) {
      // A pattern with zero owners — malformed rule.
      malformed.push({ line: lineNo, raw });
      return;
    }
    const pattern = parts[0];
    const owners = parts
      .slice(1)
      .map((o) => o.replace(/^@/, "").trim())
      .filter(Boolean);
    rules.push({ line: lineNo, raw, pattern, owners });
  });
  return { rules, malformedLines: malformed, totalLines: lines.length };
}

// ---------------------------------------------------------------------------
// Owner-token classification
// ---------------------------------------------------------------------------

export type OwnerTokenKind = "user" | "team" | "email" | "invalid";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TEAM_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;

export function classifyOwnerToken(
  tokenWithoutAt: string,
  hadAt: boolean
): OwnerTokenKind {
  if (!tokenWithoutAt) return "invalid";
  if (!hadAt && EMAIL_RE.test(tokenWithoutAt)) return "email";
  if (!hadAt) return "invalid"; // non-@ tokens must be emails
  if (tokenWithoutAt.includes("/")) {
    return TEAM_RE.test(tokenWithoutAt) ? "team" : "invalid";
  }
  return USER_RE.test(tokenWithoutAt) ? "user" : "invalid";
}

// ---------------------------------------------------------------------------
// Pattern sanity check
// ---------------------------------------------------------------------------

/**
 * GitHub's CODEOWNERS patterns are a restricted subset of gitignore-style
 * globs. This catches the obviously-broken cases without trying to be a
 * full parser — we delegate actual matching to the existing parser.
 */
export function isPlausiblePattern(pat: string): boolean {
  if (!pat) return false;
  if (/\s/.test(pat)) return false;
  // No unmatched brackets.
  let depth = 0;
  for (const ch of pat) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (depth < 0) return false;
  }
  if (depth !== 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export async function validateCodeowners(
  content: string,
  resolver: OwnerResolver
): Promise<LintReport> {
  const lex = lexCodeowners(content);
  const findings: LintFinding[] = [];

  // 1. Empty-file case.
  if (content.trim().length === 0) {
    findings.push({
      line: 1,
      code: "empty_file",
      severity: "warning",
      message:
        "CODEOWNERS file is empty — no ownership rules are being enforced.",
    });
    return assembleReport(lex.rules, findings, lex.totalLines);
  }

  // 2. Pattern-with-no-owners lines.
  for (const m of lex.malformedLines) {
    findings.push({
      line: m.line,
      code: "no_owners",
      severity: "error",
      message:
        "Rule declares a pattern but no owners. Each rule must list at least one @user, @org/team, or email.",
    });
  }

  // 3. Per-rule checks.
  const seenPatterns = new Map<string, number>();
  for (const rule of lex.rules) {
    // a) Empty / malformed pattern.
    if (!rule.pattern) {
      findings.push({
        line: rule.line,
        code: "empty_pattern",
        severity: "error",
        message: "Rule has no pattern.",
      });
      continue;
    }
    if (!isPlausiblePattern(rule.pattern)) {
      findings.push({
        line: rule.line,
        code: "bad_pattern_syntax",
        severity: "error",
        message: `Pattern \"${rule.pattern}\" looks malformed (unbalanced brackets or whitespace).`,
        pattern: rule.pattern,
      });
    }

    // b) Duplicate pattern.
    if (seenPatterns.has(rule.pattern)) {
      findings.push({
        line: rule.line,
        code: "duplicate_pattern",
        severity: "warning",
        message: `Pattern \"${rule.pattern}\" was already declared on line ${seenPatterns.get(
          rule.pattern
        )}. The later rule wins.`,
        pattern: rule.pattern,
      });
    } else {
      seenPatterns.set(rule.pattern, rule.line);
    }

    // c) Per-owner checks.
    const seenOwners = new Set<string>();
    // Re-parse the raw line to learn which owner tokens had an `@`.
    const rawOwners = rule.raw
      .replace(/#.*$/, "")
      .trim()
      .split(/\s+/)
      .slice(1);
    for (let i = 0; i < rule.owners.length; i++) {
      const owner = rule.owners[i];
      const rawToken = rawOwners[i] ?? owner;
      const hadAt = rawToken.startsWith("@");
      if (seenOwners.has(owner)) {
        findings.push({
          line: rule.line,
          code: "duplicate_owner",
          severity: "warning",
          message: `Owner \"${owner}\" listed more than once on this rule.`,
          pattern: rule.pattern,
          token: owner,
        });
        continue;
      }
      seenOwners.add(owner);
      const kind = classifyOwnerToken(owner, hadAt);
      if (kind === "invalid") {
        findings.push({
          line: rule.line,
          code: "bad_owner_format",
          severity: "error",
          message: `Owner \"${rawToken}\" isn't a valid @user, @org/team, or email.`,
          pattern: rule.pattern,
          token: rawToken,
        });
        continue;
      }
      if (kind === "user") {
        const ok = await resolver.isUser(owner);
        if (!ok) {
          findings.push({
            line: rule.line,
            code: "unknown_user",
            severity: "error",
            message: `User @${owner} does not exist on this instance.`,
            pattern: rule.pattern,
            token: owner,
          });
        }
      } else if (kind === "team") {
        const [orgSlug, teamSlug] = owner.split("/");
        const ok = await resolver.isTeam(orgSlug, teamSlug);
        if (!ok) {
          findings.push({
            line: rule.line,
            code: "unknown_team",
            severity: "error",
            message: `Team @${owner} does not exist on this instance.`,
            pattern: rule.pattern,
            token: owner,
          });
        }
      }
      // `email` is accepted as-is — we have no way to reach out and verify.
    }
  }

  // 4. Missing catch-all `*` rule. Informational only.
  const hasCatchAll = lex.rules.some(
    (r) => r.pattern === "*" || r.pattern === "/*"
  );
  if (!hasCatchAll && lex.rules.length > 0) {
    findings.push({
      line: 1,
      code: "missing_catchall",
      severity: "info",
      message:
        "No catch-all rule (`* @owner`). Files outside any pattern will have no reviewer auto-assigned.",
    });
  }

  return assembleReport(lex.rules, findings, lex.totalLines);
}

function assembleReport(
  rules: LexedRule[],
  findings: LintFinding[],
  totalLines: number
): LintReport {
  // Sort findings by line, then severity (errors first).
  const severityRank: Record<LintSeverity, number> = {
    error: 0,
    warning: 1,
    info: 2,
  };
  findings.sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    return severityRank[a.severity] - severityRank[b.severity];
  });
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  const infos = findings.filter((f) => f.severity === "info");
  return {
    totalLines,
    totalRules: rules.length,
    rules,
    findings,
    errors,
    warnings,
    infos,
    ok: errors.length === 0,
  };
}

export const __internal = {
  EMAIL_RE,
  USER_RE,
  TEAM_RE,
  lexCodeowners,
  classifyOwnerToken,
  isPlausiblePattern,
  validateCodeowners,
  assembleReport,
};
