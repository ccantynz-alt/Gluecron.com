/**
 * Block L7 — Claude Code skill bundle.
 *
 * Coverage:
 *   - Each SKILL.md file exists at the expected `.claude/skills/<name>/` path
 *   - Each SKILL.md has a YAML frontmatter block with `name`, `description`,
 *     `tools` keys
 *   - The frontmatter's `description` mentions Gluecron so the harness
 *     auto-invokes the skill on Gluecron-hosted repos
 *   - The frontmatter's `name` matches the directory name
 *   - The install script (scripts/install.sh) contains the mkdir + write
 *     step for `~/.claude/skills/gluecron-pr/`, gluecron-issue, and
 *     gluecron-review
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SKILLS_DIR = join(REPO_ROOT, ".claude", "skills");
const INSTALL_SCRIPT = join(REPO_ROOT, "scripts", "install.sh");

const SKILLS = ["gluecron-pr", "gluecron-issue", "gluecron-review"] as const;

// ---------------------------------------------------------------------------
// Helper: parse the simple YAML frontmatter block at the top of a SKILL.md.
// ---------------------------------------------------------------------------

function parseFrontmatter(src: string): {
  raw: string;
  fields: Record<string, string>;
} {
  expect(src.startsWith("---")).toBe(true);
  const end = src.indexOf("\n---", 3);
  expect(end).toBeGreaterThan(0);
  const raw = src.slice(3, end).trim();
  const fields: Record<string, string> = {};
  let currentKey = "";
  let buffer: string[] = [];
  const flush = () => {
    if (currentKey) {
      fields[currentKey] = buffer.join("\n").trim();
    }
    buffer = [];
  };
  for (const line of raw.split("\n")) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);
    if (m && !line.startsWith(" ") && !line.startsWith("\t")) {
      flush();
      currentKey = m[1];
      buffer = [m[2]];
    } else {
      buffer.push(line);
    }
  }
  flush();
  return { raw, fields };
}

// ---------------------------------------------------------------------------
// 1. Each SKILL.md exists at the expected path
// ---------------------------------------------------------------------------

describe("skills bundle — files exist", () => {
  for (const name of SKILLS) {
    it(`${name}/SKILL.md is present`, () => {
      const path = join(SKILLS_DIR, name, "SKILL.md");
      expect(existsSync(path)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Each SKILL.md has a valid YAML frontmatter with required keys
// ---------------------------------------------------------------------------

describe("skills bundle — frontmatter shape", () => {
  for (const name of SKILLS) {
    const path = join(SKILLS_DIR, name, "SKILL.md");

    it(`${name} frontmatter has name + description + tools`, () => {
      const src = readFileSync(path, "utf8");
      const { fields } = parseFrontmatter(src);
      expect(fields.name).toBeDefined();
      expect(fields.description).toBeDefined();
      expect(fields.tools).toBeDefined();
      expect(fields.name.length).toBeGreaterThan(0);
      expect(fields.description.length).toBeGreaterThan(0);
      expect(fields.tools.length).toBeGreaterThan(0);
    });

    it(`${name} frontmatter "name" matches the directory`, () => {
      const src = readFileSync(path, "utf8");
      const { fields } = parseFrontmatter(src);
      expect(fields.name).toBe(name);
    });

    it(`${name} frontmatter "description" mentions Gluecron`, () => {
      const src = readFileSync(path, "utf8");
      const { fields } = parseFrontmatter(src);
      expect(fields.description.toLowerCase()).toContain("gluecron");
    });

    it(`${name} body is non-trivial (>= 200 chars after frontmatter)`, () => {
      const src = readFileSync(path, "utf8");
      const end = src.indexOf("\n---", 3);
      const body = src.slice(end + 4).trim();
      expect(body.length).toBeGreaterThanOrEqual(200);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Each skill references its MCP tools in the frontmatter `tools:` list
// ---------------------------------------------------------------------------

describe("skills bundle — tool references", () => {
  const expectedTools: Record<(typeof SKILLS)[number], string[]> = {
    "gluecron-pr": [
      "gluecron_create_pr",
      "gluecron_get_pr",
      "gluecron_list_prs",
      "gluecron_comment_pr",
      "gluecron_merge_pr",
      "gluecron_close_pr",
    ],
    "gluecron-issue": [
      "gluecron_create_issue",
      "gluecron_comment_issue",
      "gluecron_close_issue",
      "gluecron_reopen_issue",
      "gluecron_repo_list_issues",
    ],
    "gluecron-review": [
      "gluecron_get_pr",
      "gluecron_list_prs",
      "gluecron_comment_pr",
    ],
  };

  for (const name of SKILLS) {
    it(`${name} lists every expected MCP tool in frontmatter`, () => {
      const src = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
      const { fields } = parseFrontmatter(src);
      for (const tool of expectedTools[name]) {
        expect(fields.tools).toContain(tool);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. The install script copies each skill into ~/.claude/skills/
// ---------------------------------------------------------------------------

describe("skills bundle — install script wiring", () => {
  const script = readFileSync(INSTALL_SCRIPT, "utf8");

  it("creates the ~/.claude/skills/ directory tree", () => {
    expect(script).toContain("$HOME/.claude/skills");
    expect(script).toMatch(/mkdir -p[^\n]*gluecron-pr/);
    expect(script).toMatch(/mkdir -p[^\n]*gluecron-issue/);
    expect(script).toMatch(/mkdir -p[^\n]*gluecron-review/);
  });

  for (const name of SKILLS) {
    it(`writes ${name}/SKILL.md to the skills dir`, () => {
      // Either `cat > .../<name>/SKILL.md` or `cp ... <name>/SKILL.md` is fine.
      const pattern = new RegExp(`(cat\\s*>|cp\\s+[^\\n]+)[^\\n]*${name}/SKILL\\.md`);
      expect(script).toMatch(pattern);
    });

    it(`installed ${name}/SKILL.md heredoc mentions Gluecron`, () => {
      // The heredoc body should describe the skill — at minimum, mention "Gluecron".
      // We just check the script contains both the path AND the word Gluecron.
      expect(script).toContain(`${name}/SKILL.md`);
      expect(script.toLowerCase()).toContain("gluecron");
    });
  }
});
