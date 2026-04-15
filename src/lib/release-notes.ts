/**
 * Block J15 — Release notes auto-generator.
 *
 * Deterministically classifies a list of commits by conventional-commit
 * prefix (feat / fix / perf / refactor / docs / chore / revert / style /
 * build / ci / test) and renders a grouped Markdown changelog. The whole
 * module is pure: unit tests drive it with fake commit lists. The route
 * layer calls `git log --format=...` then hands the rows in.
 *
 * If no commits carry conventional prefixes we still produce sensible
 * "Other" + "Merges" sections — we never throw and never produce an
 * empty string for a non-empty input.
 */

export type ReleaseBucket =
  | "features"
  | "fixes"
  | "perf"
  | "refactor"
  | "docs"
  | "chore"
  | "revert"
  | "style"
  | "build"
  | "ci"
  | "test"
  | "merges"
  | "other";

export interface CommitLike {
  sha: string;
  /** Subject line only (first line of the commit message). */
  message: string;
  /** Display name of the author (optional — used for contributor rollup). */
  author?: string;
}

export interface ClassifiedCommit {
  sha: string;
  bucket: ReleaseBucket;
  scope: string | null;
  subject: string;
  isBreaking: boolean;
  prNumber: number | null;
  author: string | null;
}

/** Ordered bucket list used when rendering so sections appear predictably. */
export const BUCKET_ORDER: ReleaseBucket[] = [
  "features",
  "fixes",
  "perf",
  "refactor",
  "docs",
  "test",
  "build",
  "ci",
  "style",
  "chore",
  "revert",
  "merges",
  "other",
];

const BUCKET_HEADINGS: Record<ReleaseBucket, string> = {
  features: "Features",
  fixes: "Bug fixes",
  perf: "Performance",
  refactor: "Refactors",
  docs: "Documentation",
  test: "Tests",
  build: "Build",
  ci: "CI",
  style: "Style",
  chore: "Chores",
  revert: "Reverts",
  merges: "Merges",
  other: "Other changes",
};

const PREFIX_TO_BUCKET: Record<string, ReleaseBucket> = {
  feat: "features",
  feature: "features",
  features: "features",
  fix: "fixes",
  bugfix: "fixes",
  hotfix: "fixes",
  perf: "perf",
  performance: "perf",
  refactor: "refactor",
  docs: "docs",
  doc: "docs",
  documentation: "docs",
  chore: "chore",
  revert: "revert",
  style: "style",
  build: "build",
  ci: "ci",
  test: "test",
  tests: "test",
};

// `feat(scope)!: subject` or `fix: subject` or `perf(api)!: ...`
const CONVENTIONAL_RE =
  /^(?<prefix>[a-zA-Z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?\s*:\s*(?<subject>.+)$/;

/** `Merge pull request #123 from foo/bar` or `Merge branch 'x' into y`. */
const MERGE_RE = /^Merge (pull request #(\d+)|branch|commit)/i;

/** Trailing `(#123)` PR reference, as appended by squash merges. */
const TRAILING_PR_RE = /\(#(\d+)\)\s*$/;

/** Pure: classify a single commit message subject. */
export function classifyCommit(commit: CommitLike): ClassifiedCommit {
  const rawSubject = (commit.message || "").trim();
  if (!rawSubject) {
    return {
      sha: commit.sha,
      bucket: "other",
      scope: null,
      subject: "",
      isBreaking: false,
      prNumber: null,
      author: commit.author || null,
    };
  }

  // Merge commits
  const mergeMatch = rawSubject.match(MERGE_RE);
  if (mergeMatch) {
    const prNum = mergeMatch[2] ? parseInt(mergeMatch[2], 10) : null;
    return {
      sha: commit.sha,
      bucket: "merges",
      scope: null,
      subject: rawSubject,
      isBreaking: false,
      prNumber: Number.isFinite(prNum as number) ? (prNum as number) : null,
      author: commit.author || null,
    };
  }

  // Trailing `(#N)` — pull it off the subject but preserve it in metadata.
  let subject = rawSubject;
  let prNumber: number | null = null;
  const trailingPr = subject.match(TRAILING_PR_RE);
  if (trailingPr) {
    const n = parseInt(trailingPr[1], 10);
    if (Number.isFinite(n) && n > 0) prNumber = n;
    subject = subject.replace(TRAILING_PR_RE, "").trim();
  }

  // Conventional prefix?
  const m = subject.match(CONVENTIONAL_RE);
  if (m && m.groups) {
    const prefixRaw = m.groups.prefix.toLowerCase();
    const bucket = PREFIX_TO_BUCKET[prefixRaw];
    if (bucket) {
      const scope = m.groups.scope?.trim() || null;
      return {
        sha: commit.sha,
        bucket,
        scope,
        subject: m.groups.subject.trim(),
        isBreaking: !!m.groups.bang || /BREAKING CHANGE/i.test(rawSubject),
        prNumber,
        author: commit.author || null,
      };
    }
  }

  return {
    sha: commit.sha,
    bucket: "other",
    scope: null,
    subject,
    isBreaking: /BREAKING CHANGE/i.test(rawSubject),
    prNumber,
    author: commit.author || null,
  };
}

/** Pure: group commits by bucket preserving original order within each bucket. */
export function groupCommits(
  commits: CommitLike[]
): Record<ReleaseBucket, ClassifiedCommit[]> {
  const out: Record<ReleaseBucket, ClassifiedCommit[]> = {
    features: [],
    fixes: [],
    perf: [],
    refactor: [],
    docs: [],
    test: [],
    build: [],
    ci: [],
    style: [],
    chore: [],
    revert: [],
    merges: [],
    other: [],
  };
  for (const c of commits) {
    const cls = classifyCommit(c);
    out[cls.bucket].push(cls);
  }
  return out;
}

/** Pure: unique authors sorted case-insensitively. */
export function contributorsFrom(commits: CommitLike[]): string[] {
  const seen = new Set<string>();
  for (const c of commits) {
    const a = (c.author || "").trim();
    if (a) seen.add(a);
  }
  return [...seen].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function escapeMdInline(s: string): string {
  // Keep it simple — don't escape backticks; they're meaningful in commit subjects.
  return s.replace(/\r?\n/g, " ").trim();
}

function formatRow(cls: ClassifiedCommit, ownerRepo?: string): string {
  const parts: string[] = [];
  if (cls.isBreaking) parts.push("**BREAKING**");
  if (cls.scope) parts.push(`**${escapeMdInline(cls.scope)}:**`);
  parts.push(escapeMdInline(cls.subject));
  let line = "- " + parts.filter(Boolean).join(" ");
  const shortSha = cls.sha.slice(0, 7);
  const suffixBits: string[] = [];
  if (cls.prNumber) {
    suffixBits.push(
      ownerRepo
        ? `[#${cls.prNumber}](/${ownerRepo}/pulls/${cls.prNumber})`
        : `#${cls.prNumber}`
    );
  }
  if (shortSha) {
    suffixBits.push(
      ownerRepo
        ? `[\`${shortSha}\`](/${ownerRepo}/commit/${cls.sha})`
        : `\`${shortSha}\``
    );
  }
  if (suffixBits.length) line += " (" + suffixBits.join(", ") + ")";
  return line;
}

export interface RenderOpts {
  ownerRepo?: string;
  previousTag?: string | null;
  newTag?: string;
  /** Include a "Contributors" section with a thanks list. Default true. */
  includeContributors?: boolean;
  /** Include a "Full Changelog" compare link at the bottom. Default true. */
  includeCompareLink?: boolean;
}

/** Pure: render the full Markdown changelog body. */
export function renderNotesMarkdown(
  commits: CommitLike[],
  opts: RenderOpts = {}
): string {
  const {
    ownerRepo,
    previousTag,
    newTag,
    includeContributors = true,
    includeCompareLink = true,
  } = opts;

  if (commits.length === 0) {
    return "_No commits between these refs._\n";
  }

  const groups = groupCommits(commits);
  const lines: string[] = [];

  // Surface any breaking changes up top.
  const breaking: ClassifiedCommit[] = [];
  for (const bucket of BUCKET_ORDER) {
    for (const c of groups[bucket]) if (c.isBreaking) breaking.push(c);
  }
  if (breaking.length) {
    lines.push("## \u26A0\uFE0F Breaking changes", "");
    for (const c of breaking) lines.push(formatRow(c, ownerRepo));
    lines.push("");
  }

  for (const bucket of BUCKET_ORDER) {
    const rows = groups[bucket];
    if (!rows.length) continue;
    lines.push(`## ${BUCKET_HEADINGS[bucket]}`, "");
    for (const c of rows) lines.push(formatRow(c, ownerRepo));
    lines.push("");
  }

  if (includeContributors) {
    const contribs = contributorsFrom(commits);
    if (contribs.length) {
      lines.push("## Contributors", "");
      lines.push(contribs.map((c) => `@${c}`).join(", "));
      lines.push("");
    }
  }

  if (includeCompareLink && ownerRepo && previousTag && newTag) {
    lines.push(
      `**Full Changelog:** [\`${previousTag}...${newTag}\`](/${ownerRepo}/compare/${previousTag}...${newTag})`
    );
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export const __internal = {
  classifyCommit,
  groupCommits,
  contributorsFrom,
  renderNotesMarkdown,
  BUCKET_ORDER,
  BUCKET_HEADINGS,
  PREFIX_TO_BUCKET,
};
