/**
 * Block W2 — Claude harness configuration.
 *
 * Coverage:
 *   - .claude/settings.json is valid JSON
 *   - It declares the `gluecron` MCP server with the expected URL pattern
 *   - It denies the canonical 11 GitHub-write tool names
 *   - CLAUDE.md contains the "Source of truth: Gluecron" section
 *   - Each .claude/skills/<name>/SKILL.md exists with the expected
 *     frontmatter shape (name, description, tools)
 */

import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SETTINGS_PATH = join(REPO_ROOT, ".claude", "settings.json");
const CLAUDE_MD = join(REPO_ROOT, "CLAUDE.md");
const SKILLS_DIR = join(REPO_ROOT, ".claude", "skills");

const SKILLS = ["gluecron-pr", "gluecron-issue", "gluecron-review"] as const;

const DENIED_GITHUB_WRITE_TOOLS = [
  "mcp__github__create_pull_request",
  "mcp__github__merge_pull_request",
  "mcp__github__create_or_update_file",
  "mcp__github__push_files",
  "mcp__github__delete_file",
  "mcp__github__create_branch",
  "mcp__github__create_repository",
  "mcp__github__create_pull_request_with_copilot",
  "mcp__github__update_pull_request",
  "mcp__github__update_pull_request_branch",
  "mcp__github__merge_pull_request_with_copilot",
];

// ---------------------------------------------------------------------------
// .claude/settings.json shape
// ---------------------------------------------------------------------------

describe(".claude/settings.json", () => {
  it("is valid JSON", async () => {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("declares the gluecron MCP server", async () => {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const cfg = JSON.parse(raw) as {
      mcpServers?: Record<string, { transport?: string; url?: string }>;
    };
    expect(cfg.mcpServers).toBeDefined();
    expect(cfg.mcpServers!.gluecron).toBeDefined();
    const entry = cfg.mcpServers!.gluecron!;
    expect(entry.transport).toBe("http");
    // URL ends with /mcp on a gluecron host.
    expect(entry.url).toMatch(/gluecron[^\s]*\/mcp$/);
  });

  it("passes Authorization via env var (PAT never in file)", async () => {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const cfg = JSON.parse(raw) as {
      mcpServers?: Record<
        string,
        { headers?: Record<string, string> }
      >;
    };
    const auth = cfg.mcpServers?.gluecron?.headers?.Authorization;
    expect(auth).toBeDefined();
    expect(auth).toContain("${env:GLUECRON_PAT}");
    expect(auth).toMatch(/^Bearer\s/);
  });

  it(`denies all ${DENIED_GITHUB_WRITE_TOOLS.length} canonical GitHub write tools`, async () => {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const cfg = JSON.parse(raw) as {
      permissions?: { deny?: string[] };
    };
    expect(cfg.permissions?.deny).toBeDefined();
    const deny = cfg.permissions!.deny!;
    for (const tool of DENIED_GITHUB_WRITE_TOOLS) {
      expect(deny).toContain(tool);
    }
  });
});

// ---------------------------------------------------------------------------
// CLAUDE.md "Source of truth: Gluecron" section
// ---------------------------------------------------------------------------

describe("CLAUDE.md", () => {
  it("contains the 'Source of truth: Gluecron' section", async () => {
    const raw = await readFile(CLAUDE_MD, "utf8");
    expect(raw).toContain("## Source of truth: Gluecron (not GitHub)");
  });

  it("references .claude/settings.json and the mcp-tools module", async () => {
    const raw = await readFile(CLAUDE_MD, "utf8");
    expect(raw).toContain(".claude/settings.json");
    expect(raw).toContain("src/lib/mcp-tools.ts");
  });

  it("warns against calling mcp__github__* write tools", async () => {
    const raw = await readFile(CLAUDE_MD, "utf8");
    expect(raw).toContain("mcp__github__");
  });

  it("mentions the GLUECRON_PAT env var", async () => {
    const raw = await readFile(CLAUDE_MD, "utf8");
    expect(raw).toContain("GLUECRON_PAT");
  });
});

// ---------------------------------------------------------------------------
// Each .claude/skills/<name>/SKILL.md exists and has the expected frontmatter
// ---------------------------------------------------------------------------

function parseFrontmatter(src: string): Record<string, string> {
  if (!src.startsWith("---")) {
    throw new Error("SKILL.md missing frontmatter");
  }
  const end = src.indexOf("\n---", 3);
  if (end < 0) throw new Error("SKILL.md frontmatter not terminated");
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
  return fields;
}

describe(".claude/skills/* SKILL.md shape", () => {
  for (const name of SKILLS) {
    it(`${name}/SKILL.md exists and has name+description+tools`, async () => {
      const path = join(SKILLS_DIR, name, "SKILL.md");
      const raw = await readFile(path, "utf8");
      const fields = parseFrontmatter(raw);
      expect(fields.name).toBe(name);
      expect(fields.description).toBeDefined();
      expect(fields.description.length).toBeGreaterThan(0);
      expect(fields.description.toLowerCase()).toContain("gluecron");
      expect(fields.tools).toBeDefined();
      expect(fields.tools.length).toBeGreaterThan(0);
    });
  }
});
