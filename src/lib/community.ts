/**
 * Block J12 — Community profile / health scorecard.
 *
 * Pure + git-layer helpers that score a repo on its community health files
 * (README, LICENSE, CODE_OF_CONDUCT, CONTRIBUTING, issue templates, PR
 * template) plus repo metadata (description, topics). Mirrors GitHub's
 * "Community Standards" checklist.
 *
 * The check list itself is a pure table so unit tests can verify each rule
 * without touching git or the DB.
 */

import { getDefaultBranch, getTree } from "../git/repository";
import type { GitTreeEntry } from "../git/repository";

export type ChecklistKey =
  | "description"
  | "readme"
  | "license"
  | "code_of_conduct"
  | "contributing"
  | "issue_template"
  | "pr_template"
  | "topics";

export interface ChecklistItem {
  key: ChecklistKey;
  label: string;
  description: string;
  /** Path suggested in the "add this file" UI if it's missing. */
  suggestedPath?: string;
  required: boolean;
}

export const CHECKLIST: ChecklistItem[] = [
  {
    key: "description",
    label: "Description",
    description: "A one-line summary so people know what the repo is for.",
    required: true,
  },
  {
    key: "readme",
    label: "README",
    description:
      "README tells people what the project is and how to use it. Accepted names: README, README.md, README.txt, README.rst.",
    suggestedPath: "README.md",
    required: true,
  },
  {
    key: "license",
    label: "License",
    description:
      "Without a license file, the default is 'all rights reserved'. Accepted names: LICENSE, LICENSE.md, LICENSE.txt, COPYING.",
    suggestedPath: "LICENSE",
    required: true,
  },
  {
    key: "code_of_conduct",
    label: "Code of Conduct",
    description:
      "A Code of Conduct clarifies expectations for behaviour in the community.",
    suggestedPath: "CODE_OF_CONDUCT.md",
    required: false,
  },
  {
    key: "contributing",
    label: "Contributing guidelines",
    description: "Tells potential contributors how to propose changes.",
    suggestedPath: "CONTRIBUTING.md",
    required: false,
  },
  {
    key: "issue_template",
    label: "Issue templates",
    description:
      "Templates under .github/ISSUE_TEMPLATE/ help reporters file useful bugs.",
    suggestedPath: ".github/ISSUE_TEMPLATE/bug_report.md",
    required: false,
  },
  {
    key: "pr_template",
    label: "Pull-request template",
    description:
      "A PR template nudges contributors to summarise their change. Accepted names: .github/pull_request_template.md, PULL_REQUEST_TEMPLATE.md.",
    suggestedPath: ".github/pull_request_template.md",
    required: false,
  },
  {
    key: "topics",
    label: "Topics",
    description:
      "Add topics so people can discover your project on the Explore page.",
    required: false,
  },
];

export type HealthResult = Record<ChecklistKey, boolean>;

export interface HealthReport {
  items: Array<ChecklistItem & { present: boolean }>;
  passed: number;
  total: number;
  requiredPassed: number;
  requiredTotal: number;
  /** 0 – 100 integer percentage of items passed overall. */
  score: number;
  /** true when all `required` items are present. */
  meetsRequired: boolean;
}

const README_RE = /^readme(\.(md|txt|rst|markdown))?$/i;
const LICENSE_RE = /^(license|licence|copying)(\.(md|txt|rst))?$/i;
const COC_RE = /^code[_-]?of[_-]?conduct(\.(md|txt))?$/i;
const CONTRIBUTING_RE = /^contributing(\.(md|txt))?$/i;
const PR_TEMPLATE_RE = /^pull[_-]?request[_-]?template(\.(md|txt))?$/i;

/** Pure name-matcher helpers — exported for unit tests. */
export function isReadme(name: string): boolean {
  return README_RE.test(name);
}
export function isLicense(name: string): boolean {
  return LICENSE_RE.test(name);
}
export function isCodeOfConduct(name: string): boolean {
  return COC_RE.test(name);
}
export function isContributing(name: string): boolean {
  return CONTRIBUTING_RE.test(name);
}
export function isPrTemplate(name: string): boolean {
  return PR_TEMPLATE_RE.test(name);
}

/**
 * Given a set of pure inputs (what files exist at the root, what files
 * exist in `.github/`, whether the issue-template directory exists, and the
 * repo metadata), compute the checklist result. No IO — unit tests drive
 * this directly.
 */
export function checklistFromInputs(opts: {
  rootEntries: string[];
  githubEntries: string[];
  issueTemplateDirExists: boolean;
  description: string | null | undefined;
  topics: string[];
}): HealthResult {
  const root = opts.rootEntries.map((n) => n);
  const gh = opts.githubEntries.map((n) => n);

  const anywhere = (pred: (n: string) => boolean) =>
    root.some(pred) || gh.some(pred);

  return {
    description: !!(opts.description && opts.description.trim().length > 0),
    readme: anywhere(isReadme),
    license: anywhere(isLicense),
    code_of_conduct: anywhere(isCodeOfConduct),
    contributing: anywhere(isContributing),
    issue_template:
      opts.issueTemplateDirExists ||
      // Fallback: single `ISSUE_TEMPLATE.md` at root or .github
      anywhere((n) => /^issue[_-]?template(\.(md|txt))?$/i.test(n)),
    pr_template: anywhere(isPrTemplate),
    topics: opts.topics.length > 0,
  };
}

/** Turn raw booleans into a sorted + annotated report. */
export function buildReport(result: HealthResult): HealthReport {
  const items = CHECKLIST.map((item) => ({ ...item, present: result[item.key] }));
  const passed = items.filter((i) => i.present).length;
  const required = items.filter((i) => i.required);
  const requiredPassed = required.filter((i) => i.present).length;
  const score = items.length === 0 ? 0 : Math.round((passed / items.length) * 100);
  return {
    items,
    passed,
    total: items.length,
    requiredPassed,
    requiredTotal: required.length,
    score,
    meetsRequired: requiredPassed === required.length,
  };
}

/**
 * Walk the default branch of a repo and produce the community health
 * report. Returns a safe all-false report on git/DB failure — never throws.
 */
export async function computeHealth(opts: {
  owner: string;
  repo: string;
  description: string | null | undefined;
  topics: string[];
}): Promise<HealthReport> {
  try {
    const branch =
      (await getDefaultBranch(opts.owner, opts.repo)) || "main";
    const rootTree = await safeTree(opts.owner, opts.repo, branch, "");
    const githubTree = await safeTree(opts.owner, opts.repo, branch, ".github");
    const rootNames = rootTree.map((e) => e.name);
    const githubNames = githubTree.map((e) => e.name);
    const issueTemplateDir = githubTree.some(
      (e) => e.type === "tree" && /^ISSUE_TEMPLATE$/i.test(e.name)
    );
    const result = checklistFromInputs({
      rootEntries: rootNames,
      githubEntries: githubNames,
      issueTemplateDirExists: issueTemplateDir,
      description: opts.description,
      topics: opts.topics,
    });
    return buildReport(result);
  } catch {
    const zero: HealthResult = {
      description: false,
      readme: false,
      license: false,
      code_of_conduct: false,
      contributing: false,
      issue_template: false,
      pr_template: false,
      topics: false,
    };
    return buildReport(zero);
  }
}

async function safeTree(
  owner: string,
  repo: string,
  ref: string,
  treePath: string
): Promise<GitTreeEntry[]> {
  try {
    return await getTree(owner, repo, ref, treePath);
  } catch {
    return [];
  }
}

export const __internal = { README_RE, LICENSE_RE, COC_RE, CONTRIBUTING_RE, PR_TEMPLATE_RE };
