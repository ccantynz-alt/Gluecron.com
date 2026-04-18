/**
 * Security + secret scanner.
 * Runs on every push (via post-receive) AND every PR.
 * Combines fast regex detection for secrets with an AI-powered semantic review
 * for risky patterns (SSRF, SQL injection, XSS, unsafe deserialisation, etc).
 */

import { getAnthropic, MODEL_SONNET, extractText, parseJsonResponse, isAiAvailable } from "./ai-client";

export interface SecretFinding {
  type: string;
  file: string;
  line: number;
  snippet: string;
  severity: "critical" | "high" | "medium" | "low";
}

export interface SecurityFinding {
  type: string;
  file: string;
  line?: number;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  suggestion?: string;
}

export interface ScanResult {
  secrets: SecretFinding[];
  securityIssues: SecurityFinding[];
  summary: string;
  passed: boolean;
}

interface SecretPattern {
  type: string;
  regex: RegExp;
  severity: SecretFinding["severity"];
}

// High-signal secret detectors. Ordered most-specific first.
export const SECRET_PATTERNS: SecretPattern[] = [
  { type: "AWS Access Key", regex: /\b(AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/, severity: "critical" },
  { type: "AWS Secret Key", regex: /aws(.{0,20})?(secret|access)?(.{0,20})?['\"]([A-Za-z0-9/+=]{40})['\"]/i, severity: "critical" },
  { type: "GitHub Token", regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,251}\b/, severity: "critical" },
  { type: "Anthropic API Key", regex: /\bsk-ant-(api03|admin01)-[A-Za-z0-9_-]{80,}\b/, severity: "critical" },
  { type: "OpenAI API Key", regex: /\bsk-(proj-|live-)?[A-Za-z0-9_-]{32,}\b/, severity: "critical" },
  { type: "Stripe Key", regex: /\b(sk_live_|rk_live_|pk_live_)[A-Za-z0-9]{24,}\b/, severity: "critical" },
  { type: "Slack Token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, severity: "high" },
  { type: "Google API Key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: "high" },
  { type: "SendGrid Key", regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, severity: "high" },
  { type: "Twilio Key", regex: /\bSK[0-9a-fA-F]{32}\b/, severity: "high" },
  { type: "Generic API Token", regex: /(?:api[_-]?key|apikey|access[_-]?token|secret)["'\s:=]+["']?([A-Za-z0-9_\-]{24,})["']?/i, severity: "medium" },
  { type: "Private Key (PEM)", regex: /-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/, severity: "critical" },
  { type: "JWT", regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/, severity: "medium" },
  { type: "Postgres URL", regex: /\bpostgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@[^/\s]+\/\S+/, severity: "high" },
  { type: "Mongo URL", regex: /\bmongodb(?:\+srv)?:\/\/[^:\s]+:[^@\s]+@[^/\s]+\/\S+/, severity: "high" },
];

// Paths we skip entirely (noise, binaries, generated files)
const SKIP_PATHS = [
  /(^|\/)\.git\//,
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.next\//,
  /(^|\/)\.cache\//,
  /\.(png|jpg|jpeg|gif|webp|ico|svg|pdf|mp4|mov|wasm|woff2?|ttf|eot|map)$/i,
  /(^|\/)bun\.lock(b)?$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
];

export function shouldSkipPath(path: string): boolean {
  return SKIP_PATHS.some((re) => re.test(path));
}

/**
 * Fast local regex-based secret scanner. No network, no Claude — safe to run
 * on every push regardless of whether the AI key is configured.
 */
export function scanForSecrets(
  files: Array<{ path: string; content: string }>
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    if (shouldSkipPath(file.path)) continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip lines that look like placeholders / tests
      if (
        /example|placeholder|fake|dummy|your[-_]?api|xxxxx|testkey|changeme/i.test(
          line
        )
      ) {
        continue;
      }
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.regex.test(line)) {
          findings.push({
            type: pattern.type,
            file: file.path,
            line: i + 1,
            snippet: line.trim().slice(0, 200),
            severity: pattern.severity,
          });
          break; // one finding per line
        }
      }
    }
  }
  return findings;
}

/**
 * Ask Claude to review a diff or snapshot for security issues.
 * Returns structured findings; safe to call without AI key (returns empty).
 */
export async function aiSecurityScan(
  repoFullName: string,
  diffOrSnapshot: string
): Promise<SecurityFinding[]> {
  if (!isAiAvailable()) return [];
  const client = getAnthropic();

  try {
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `You are a security auditor reviewing code on the repository "${repoFullName}".

Analyse the following code for high-signal security issues:
- Injection (SQL, command, LDAP, XPath)
- Cross-site scripting (XSS)
- Insecure deserialisation
- SSRF / unvalidated redirects
- Path traversal
- Broken authentication / authorisation (e.g. missing access checks)
- Insecure cryptography (weak hashing for passwords, hard-coded IVs)
- Race conditions with security impact
- Insufficient input validation at a trust boundary

Do NOT report low-risk style issues, noisy defensive-coding suggestions, or theoretical risks without a plausible trigger.

Respond ONLY with JSON of shape:
{
  "findings": [
    { "type": "SQL Injection", "file": "src/x.ts", "line": 42, "severity": "high", "description": "...", "suggestion": "..." }
  ]
}

If the code is clean, return { "findings": [] }.

\`\`\`
${diffOrSnapshot.slice(0, 80000)}
\`\`\``,
        },
      ],
    });

    const text = extractText(message);
    const parsed = parseJsonResponse<{ findings: SecurityFinding[] }>(text);
    if (!parsed || !Array.isArray(parsed.findings)) return [];
    // Normalise severity
    return parsed.findings.map((f) => ({
      ...f,
      severity: (["critical", "high", "medium", "low"].includes(f.severity as string)
        ? f.severity
        : "medium") as SecurityFinding["severity"],
    }));
  } catch (err) {
    console.error("[security-scan] AI scan failed:", err);
    return [];
  }
}

/**
 * Run full security scan: regex secrets + (optional) AI security review.
 */
export async function runSecurityScan(
  repoFullName: string,
  files: Array<{ path: string; content: string }>,
  diffText?: string
): Promise<ScanResult> {
  const secrets = scanForSecrets(files);
  const securityIssues = diffText
    ? await aiSecurityScan(repoFullName, diffText)
    : [];

  const criticalSecrets = secrets.filter((s) => s.severity === "critical").length;
  const criticalIssues = securityIssues.filter((i) => i.severity === "critical").length;
  const highIssues = securityIssues.filter((i) => i.severity === "high").length;

  const passed = criticalSecrets === 0 && criticalIssues === 0 && highIssues === 0;

  const parts: string[] = [];
  if (secrets.length) parts.push(`${secrets.length} secret${secrets.length === 1 ? "" : "s"}`);
  if (securityIssues.length)
    parts.push(
      `${securityIssues.length} security issue${securityIssues.length === 1 ? "" : "s"}`
    );
  const summary =
    parts.length === 0
      ? "No issues detected"
      : `Found ${parts.join(" + ")} (${criticalSecrets + criticalIssues} critical, ${highIssues} high)`;

  return { secrets, securityIssues, summary, passed };
}
