/**
 * Block J17 — Multi-template issue selector.
 *
 * Scans `.github/ISSUE_TEMPLATE/` (plus `.gluecron/ISSUE_TEMPLATE/`) on the
 * default branch for `*.md` files, parses their YAML-frontmatter metadata
 * (`name`, `about`, `title`, `labels`), and exposes the list to the
 * new-issue flow so users can pick which template to start from.
 *
 * The frontmatter parser is purpose-built for this narrow shape — it's not a
 * full YAML parser. All helpers are pure; `listIssueTemplates` wraps them
 * with git I/O and returns `[]` on any failure.
 */

import { getBlob, getDefaultBranch, getTree } from "../git/repository";
import type { GitTreeEntry } from "../git/repository";

export const TEMPLATE_DIRS = [
  ".github/ISSUE_TEMPLATE",
  ".github/issue_template",
  ".gluecron/ISSUE_TEMPLATE",
  ".gluecron/issue_template",
];

const MAX_TEMPLATE_BYTES = 32 * 1024;
const MAX_TEMPLATES = 20;

export interface IssueTemplateMeta {
  name: string | null;
  about: string | null;
  title: string | null;
  labels: string[];
  assignees: string[];
}

export interface IssueTemplate {
  slug: string;
  path: string;
  name: string;
  about: string | null;
  title: string | null;
  labels: string[];
  assignees: string[];
  body: string;
}

// ---------------------------------------------------------------------------
// Pure frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Extract `---\n<frontmatter>\n---\n<body>` from a template file.
 * Returns `{meta: null, body: content}` if no frontmatter is present.
 */
export function splitFrontmatter(content: string): {
  frontmatter: string | null;
  body: string;
} {
  if (!content.startsWith("---")) {
    return { frontmatter: null, body: content };
  }
  const rest = content.slice(3);
  // Frontmatter ends at the first "\n---" on its own line.
  const match = rest.match(/\n---[\s]*\n/);
  if (!match || match.index === undefined) {
    return { frontmatter: null, body: content };
  }
  const frontmatter = rest.slice(0, match.index).replace(/^\n/, "");
  const body = rest.slice(match.index + match[0].length);
  return { frontmatter, body };
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function parseList(raw: string): string[] {
  const v = raw.trim();
  if (!v) return [];
  // Flow-list: [a, "b", c]
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter(Boolean);
  }
  // Comma-separated fallback
  return v
    .split(",")
    .map((s) => unquote(s.trim()))
    .filter(Boolean);
}

/**
 * Pure: parse the tiny subset of YAML that issue-template frontmatter uses.
 * Supports flat `key: value` pairs, block-scalar values on continuation lines
 * (not common here) are flattened into a single line, and YAML block-list
 * values (`labels:\n  - bug\n  - triage`).
 */
export function parseFrontmatterMeta(text: string): IssueTemplateMeta {
  const meta: IssueTemplateMeta = {
    name: null,
    about: null,
    title: null,
    labels: [],
    assignees: [],
  };
  if (!text) return meta;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0 || /^\s/.test(line)) {
      i++;
      continue;
    }
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const rest = line.slice(colonIdx + 1).trim();
    if (rest === "" || rest === ">" || rest === "|") {
      // Block list? Peek at next indented `- ` lines.
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s+-\s?/.test(lines[i])) {
        items.push(unquote(lines[i].replace(/^\s+-\s?/, "")));
        i++;
      }
      if (key === "labels") meta.labels = items.filter(Boolean);
      else if (key === "assignees") meta.assignees = items.filter(Boolean);
      continue;
    }
    if (key === "name") meta.name = unquote(rest);
    else if (key === "about") meta.about = unquote(rest);
    else if (key === "title") meta.title = unquote(rest);
    else if (key === "labels") meta.labels = parseList(rest);
    else if (key === "assignees") meta.assignees = parseList(rest);
    i++;
  }
  return meta;
}

/** Pure: derive a URL-safe slug from the filename and fall back to the meta name. */
export function slugFromFilename(filename: string): string {
  const base = filename.replace(/\.(md|yml|yaml)$/i, "");
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Pure: merge filename + parsed meta + body into a single template row. */
export function buildTemplateFromFile(
  filename: string,
  content: string,
  dirPath: string
): IssueTemplate {
  const { frontmatter, body } = splitFrontmatter(content);
  const meta = frontmatter
    ? parseFrontmatterMeta(frontmatter)
    : {
        name: null,
        about: null,
        title: null,
        labels: [],
        assignees: [],
      };
  const slug = slugFromFilename(filename);
  return {
    slug,
    path: dirPath ? `${dirPath}/${filename}` : filename,
    name: meta.name || filename.replace(/\.(md|yml|yaml)$/i, ""),
    about: meta.about,
    title: meta.title,
    labels: meta.labels,
    assignees: meta.assignees,
    body: body.trim(),
  };
}

// ---------------------------------------------------------------------------
// Git-layer wrapper
// ---------------------------------------------------------------------------

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

/**
 * Scan the template directories and return a de-duplicated list of issue
 * templates in the order they appear on disk (alphabetised by path).
 * Silently swallows all git failures.
 */
export async function listIssueTemplates(
  owner: string,
  repo: string
): Promise<IssueTemplate[]> {
  try {
    const ref = (await getDefaultBranch(owner, repo)) || "HEAD";
    const seenSlugs = new Set<string>();
    const out: IssueTemplate[] = [];
    for (const dir of TEMPLATE_DIRS) {
      const entries = await safeTree(owner, repo, ref, dir);
      if (!entries.length) continue;
      const files = entries
        .filter(
          (e) =>
            e.type === "blob" &&
            /\.(md|markdown)$/i.test(e.name) &&
            !/^config\./i.test(e.name)
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const f of files) {
        if (out.length >= MAX_TEMPLATES) break;
        const fullPath = `${dir}/${f.name}`;
        let blob: Awaited<ReturnType<typeof getBlob>> | null = null;
        try {
          blob = await getBlob(owner, repo, ref, fullPath);
        } catch {
          blob = null;
        }
        if (!blob || blob.isBinary || !blob.content) continue;
        const content =
          blob.content.length > MAX_TEMPLATE_BYTES
            ? blob.content.slice(0, MAX_TEMPLATE_BYTES)
            : blob.content;
        const template = buildTemplateFromFile(f.name, content, dir);
        if (seenSlugs.has(template.slug)) continue;
        seenSlugs.add(template.slug);
        out.push(template);
      }
      if (out.length >= MAX_TEMPLATES) break;
    }
    return out;
  } catch (err) {
    console.error("[issue-templates] listIssueTemplates failed:", err);
    return [];
  }
}

/** Find a template by slug from a prefetched list. Pure. */
export function findTemplateBySlug(
  templates: IssueTemplate[],
  slug: string | null | undefined
): IssueTemplate | null {
  if (!slug) return null;
  return templates.find((t) => t.slug === slug) || null;
}

export const __internal = {
  splitFrontmatter,
  parseFrontmatterMeta,
  slugFromFilename,
  buildTemplateFromFile,
  findTemplateBySlug,
  TEMPLATE_DIRS,
  MAX_TEMPLATE_BYTES,
  MAX_TEMPLATES,
};
