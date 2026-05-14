/**
 * BLOCK R4 — Docs sweep smoke checks.
 *
 * Verifies the "web-first, terminal-fallback" treatment is in place:
 *
 *  1. README.md contains no `ssh root@gluecron.com` and no
 *     `bun run scripts/` references outside `<details>` blocks.
 *  2. DEPLOY.md has a "Day-to-day operations" section that points
 *     at `/admin/ops`.
 *  3. `docs/terminal-debt.md` exists and is non-empty.
 *
 * No mocks — pure filesystem reads.
 */

import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** Strip every `<details>...</details>` block (case-insensitive, multiline). */
function stripDetails(markdown: string): string {
  return markdown.replace(/<details[\s\S]*?<\/details>/gi, "");
}

describe("BLOCK R4 — docs sweep", () => {
  describe("README.md", () => {
    it("does not reference `ssh root@gluecron.com` outside <details>", async () => {
      const md = await readFile(join(ROOT, "README.md"), "utf8");
      const stripped = stripDetails(md);
      expect(stripped).not.toContain("ssh root@gluecron.com");
    });

    it("does not reference `bun run scripts/` outside <details>", async () => {
      const md = await readFile(join(ROOT, "README.md"), "utf8");
      const stripped = stripDetails(md);
      expect(stripped).not.toContain("bun run scripts/");
    });
  });

  describe("DEPLOY.md", () => {
    it("has a Day-to-day operations section that points at /admin/ops", async () => {
      const md = await readFile(join(ROOT, "DEPLOY.md"), "utf8");
      expect(md).toContain("Day-to-day operations");
      expect(md).toContain("/admin/ops");
    });
  });

  describe("docs/terminal-debt.md", () => {
    it("exists and is non-empty", async () => {
      const md = await readFile(
        join(ROOT, "docs", "terminal-debt.md"),
        "utf8",
      );
      expect(md.trim().length).toBeGreaterThan(0);
    });
  });
});
