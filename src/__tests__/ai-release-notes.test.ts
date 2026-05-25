/**
 * Tests for src/lib/ai-release-notes.ts.
 *
 * Two layers:
 *
 *   1. Pure helpers — bucketing, prompt assembly, markdown rendering.
 *      No DB / no Claude. Always run.
 *
 *   2. End-to-end through `generateReleaseNotes` with a fake Claude
 *      client + a real bare repo on disk. DB-touching assertions are
 *      gated on DATABASE_URL via the HAS_DB skipIf pattern used across
 *      the rest of the suite.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import {
  bucketPrs,
  buildReleaseNotesPrompt,
  classifyPr,
  generateReleaseNotes,
  isSemverTag,
  mergeClaudeSections,
  prNumberFromCommitMessage,
  renderPrBullet,
  renderSectionsToMarkdown,
  resolvePrsForCommits,
  type ResolvedPullRequest,
  type ReleaseSections,
} from "../lib/ai-release-notes";
import {
  initBareRepo,
  createOrUpdateFileOnBranch,
  createTag,
  resolveRef,
} from "../git/repository";
import { db } from "../db";
import { eq } from "drizzle-orm";
import {
  pullRequests,
  repositories,
  users,
} from "../db/schema";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const TEST_REPOS = join(
  import.meta.dir,
  "../../.test-repos-ai-release-notes-" + Date.now()
);

beforeAll(async () => {
  process.env.GIT_REPOS_PATH = TEST_REPOS;
  await rm(TEST_REPOS, { recursive: true, force: true });
  await mkdir(TEST_REPOS, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function pr(overrides: Partial<ResolvedPullRequest>): ResolvedPullRequest {
  return {
    number: 1,
    title: "feat: thing",
    body: null,
    authorUsername: "alice",
    headBranch: "feature/x",
    mergedAt: new Date("2026-01-01T00:00:00Z"),
    labels: [],
    autoMergedByAi: false,
    ...overrides,
  };
}

describe("classifyPr", () => {
  it("routes auto-merged PRs to ai_changes", () => {
    expect(classifyPr(pr({ autoMergedByAi: true }))).toBe("ai_changes");
  });

  it("routes by label first", () => {
    expect(classifyPr(pr({ title: "anything", labels: ["security"] }))).toBe(
      "security"
    );
    expect(classifyPr(pr({ title: "anything", labels: ["bug"] }))).toBe(
      "fixes"
    );
    expect(classifyPr(pr({ title: "anything", labels: ["ai:feature"] }))).toBe(
      "features"
    );
    expect(classifyPr(pr({ title: "anything", labels: ["ai:auto-merge"] }))).toBe(
      "ai_changes"
    );
  });

  it("falls back to conventional-commit prefix on the title", () => {
    expect(classifyPr(pr({ title: "feat: new x" }))).toBe("features");
    expect(classifyPr(pr({ title: "feat(api): scoped" }))).toBe("features");
    expect(classifyPr(pr({ title: "fix: bug" }))).toBe("fixes");
    expect(classifyPr(pr({ title: "perf: faster" }))).toBe("perf");
    expect(classifyPr(pr({ title: "docs: readme" }))).toBe("docs");
    expect(classifyPr(pr({ title: "security: sanitise" }))).toBe("security");
  });

  it("dumps anything unclassified into 'other'", () => {
    expect(classifyPr(pr({ title: "tidy up" }))).toBe("other");
    expect(classifyPr(pr({ title: "refactor: split file" }))).toBe("other");
  });
});

describe("renderPrBullet", () => {
  it("strips the conventional-commit prefix and adds attribution", () => {
    const out = renderPrBullet(pr({ number: 42, title: "feat(api): scoped thing", authorUsername: "bob" }));
    expect(out).toBe("scoped thing (#42) — @bob");
  });
});

describe("bucketPrs", () => {
  it("groups PRs into the right sections", () => {
    const sections = bucketPrs([
      pr({ number: 1, title: "feat: A" }),
      pr({ number: 2, title: "fix: B" }),
      pr({ number: 3, title: "perf: C" }),
      pr({ number: 4, title: "anything", autoMergedByAi: true }),
      pr({ number: 5, title: "refactor: D" }),
    ]);
    expect(sections.features.bullets.length).toBe(1);
    expect(sections.fixes.bullets.length).toBe(1);
    expect(sections.perf.bullets.length).toBe(1);
    expect(sections.ai_changes.bullets.length).toBe(1);
    expect(sections.other.bullets.length).toBe(1);
    expect(sections.security.bullets.length).toBe(0);
    expect(sections.docs.bullets.length).toBe(0);
  });
});

describe("prNumberFromCommitMessage", () => {
  it("recognises GitHub-style merge commits", () => {
    expect(prNumberFromCommitMessage("Merge pull request #42 from foo/bar")).toBe(42);
  });
  it("recognises squash subjects", () => {
    expect(prNumberFromCommitMessage("feat: stuff (#7)")).toBe(7);
  });
  it("returns null on missing", () => {
    expect(prNumberFromCommitMessage("plain commit")).toBeNull();
  });
});

describe("buildReleaseNotesPrompt", () => {
  it("embeds repo, range, grouped sections, and raw PRs", () => {
    const sections: ReleaseSections = {
      features: { bullets: ["A (#1) — @alice"] },
      fixes: { bullets: [] },
      perf: { bullets: [] },
      docs: { bullets: [] },
      security: { bullets: [] },
      ai_changes: { bullets: [] },
      other: { bullets: [] },
    };
    const prompt = buildReleaseNotesPrompt({
      repoFullName: "alice/demo",
      fromTag: "v1.0.0",
      toTag: "v1.1.0",
      sections,
      prs: [pr({ number: 1, title: "feat: A" })],
    });
    expect(prompt).toContain("alice/demo");
    expect(prompt).toContain("v1.0.0");
    expect(prompt).toContain("v1.1.0");
    expect(prompt).toContain("features:");
    expect(prompt).toContain("A (#1) — @alice");
    expect(prompt).toContain('"sections"');
    expect(prompt).toContain('"headline"');
  });

  it("notes the initial release case when fromTag is null", () => {
    const prompt = buildReleaseNotesPrompt({
      repoFullName: "alice/demo",
      fromTag: null,
      toTag: "v0.1.0",
      sections: {
        features: { bullets: [] },
        fixes: { bullets: [] },
        perf: { bullets: [] },
        docs: { bullets: [] },
        security: { bullets: [] },
        ai_changes: { bullets: [] },
        other: { bullets: [] },
      },
      prs: [],
    });
    expect(prompt).toContain("(initial)");
  });
});

describe("mergeClaudeSections", () => {
  const deterministic: ReleaseSections = {
    features: { bullets: ["thing (#1) — @alice"] },
    fixes: { bullets: ["bug (#2) — @bob"] },
    perf: { bullets: [] },
    docs: { bullets: [] },
    security: { bullets: [] },
    ai_changes: { bullets: [] },
    other: { bullets: [] },
  };

  it("returns deterministic when Claude is null", () => {
    expect(mergeClaudeSections(deterministic, null)).toEqual(deterministic);
  });

  it("prefers Claude wording when it covers all bullets", () => {
    const merged = mergeClaudeSections(deterministic, {
      sections: {
        features: { bullets: ["Add the thing (#1) — @alice"] },
      },
    });
    expect(merged.features.bullets).toEqual(["Add the thing (#1) — @alice"]);
    // Untouched bucket stays deterministic.
    expect(merged.fixes.bullets).toEqual(["bug (#2) — @bob"]);
  });

  it("keeps deterministic when Claude drops bullets", () => {
    const merged = mergeClaudeSections(deterministic, {
      sections: {
        // Claude returned fewer items than we know about — distrust.
        fixes: { bullets: [] },
      },
    });
    expect(merged.fixes.bullets).toEqual(["bug (#2) — @bob"]);
  });
});

describe("renderSectionsToMarkdown", () => {
  it("emits a header, headline, summary, and ordered sections", () => {
    const md = renderSectionsToMarkdown({
      repoFullName: "alice/demo",
      fromTag: "v1.0.0",
      toTag: "v1.1.0",
      headline: "Stability + speed.",
      summary: "This release tightens the merge queue.",
      sections: {
        features: { bullets: ["A (#1) — @alice"] },
        fixes: { bullets: ["B (#2) — @bob"] },
        perf: { bullets: [] },
        docs: { bullets: [] },
        security: { bullets: ["sanitise (#3) — @carol"] },
        ai_changes: { bullets: [] },
        other: { bullets: [] },
      },
    });
    expect(md).toContain("## v1.1.0 (since v1.0.0)");
    expect(md).toContain("**Stability + speed.**");
    expect(md).toContain("This release tightens the merge queue.");
    // Features comes before fixes, which comes before security.
    const feat = md.indexOf("### Features");
    const fixIdx = md.indexOf("### Bug fixes");
    const sec = md.indexOf("### Security");
    expect(feat).toBeGreaterThan(0);
    expect(fixIdx).toBeGreaterThan(feat);
    expect(sec).toBeGreaterThan(fixIdx);
    expect(md).toContain("- A (#1) — @alice");
    expect(md).toContain("- B (#2) — @bob");
    // Empty sections are skipped.
    expect(md).not.toContain("### Performance");
    expect(md).not.toContain("### Documentation");
  });

  it("skips the headline + summary lines when both are empty", () => {
    const md = renderSectionsToMarkdown({
      repoFullName: "alice/demo",
      fromTag: null,
      toTag: "v0.1.0",
      headline: "",
      summary: "",
      sections: {
        features: { bullets: [] },
        fixes: { bullets: [] },
        perf: { bullets: [] },
        docs: { bullets: [] },
        security: { bullets: [] },
        ai_changes: { bullets: [] },
        other: { bullets: [] },
      },
    });
    expect(md).toContain("## v0.1.0");
    expect(md).not.toContain("**");
    expect(md).toContain("(initial)...v0.1.0");
  });
});

describe("isSemverTag", () => {
  it("accepts vX.Y.Z and X.Y.Z", () => {
    expect(isSemverTag("v1.2.3")).toBe(true);
    expect(isSemverTag("1.2.3")).toBe(true);
    expect(isSemverTag("v0.1.0-beta.1")).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isSemverTag("release-2024-01")).toBe(false);
    expect(isSemverTag("v1")).toBe(false);
    expect(isSemverTag("nightly")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end with fake Claude + real bare repo. DB-backed.
// ---------------------------------------------------------------------------

/**
 * Fake Anthropic client returning a canned JSON envelope. Matches the
 * shape ai-release-notes's parser expects.
 */
function fakeClient(responseText: string) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text" as const, text: responseText }],
      }),
    },
  } as any;
}

describe.skipIf(!HAS_DB)("generateReleaseNotes — end-to-end with fake Claude", () => {
  const OWNER = `relnotes_${Date.now().toString(36)}`;
  const REPO = "subject";
  let repositoryId = "";
  let userId = "";
  let toSha = "";

  beforeAll(async () => {
    // Seed user + repo + bare git repo on disk with two commits and two tags.
    const [u] = await db
      .insert(users)
      .values({
        username: OWNER,
        email: `${OWNER}@example.com`,
        passwordHash: "x",
      })
      .returning({ id: users.id });
    userId = u.id;

    const [r] = await db
      .insert(repositories)
      .values({
        ownerId: userId,
        name: REPO,
        diskPath: `/tmp/${OWNER}/${REPO}`,
        defaultBranch: "main",
      })
      .returning({ id: repositories.id });
    repositoryId = r.id;

    await initBareRepo(OWNER, REPO);

    const seed = await createOrUpdateFileOnBranch({
      owner: OWNER,
      name: REPO,
      branch: "main",
      filePath: "README.md",
      bytes: new TextEncoder().encode("# v1\n"),
      message: "initial commit",
      authorName: "Seeder",
      authorEmail: "seed@example.com",
    });
    if ("error" in seed) throw new Error(`seed failed: ${seed.error}`);
    await createTag(OWNER, REPO, "v1.0.0", seed.commitSha, "v1.0.0");

    // Commit referencing PR #1 — landed as a squash subject.
    const c1 = await createOrUpdateFileOnBranch({
      owner: OWNER,
      name: REPO,
      branch: "main",
      filePath: "src/feature.ts",
      bytes: new TextEncoder().encode("export const f = 1;\n"),
      message: "feat: add feature (#1)",
      authorName: "Alice",
      authorEmail: "alice@example.com",
    });
    if ("error" in c1) throw new Error(`c1 failed: ${c1.error}`);

    // Commit referencing PR #2 — a fix.
    const c2 = await createOrUpdateFileOnBranch({
      owner: OWNER,
      name: REPO,
      branch: "main",
      filePath: "src/fix.ts",
      bytes: new TextEncoder().encode("export const fixed = true;\n"),
      message: "fix: handle null case (#2)",
      authorName: "Bob",
      authorEmail: "bob@example.com",
    });
    if ("error" in c2) throw new Error(`c2 failed: ${c2.error}`);

    await createTag(OWNER, REPO, "v1.1.0", c2.commitSha, "v1.1.0");
    toSha = c2.commitSha;

    // Insert two merged PR rows so cross-referencing succeeds.
    await db.insert(pullRequests).values({
      repositoryId,
      authorId: userId,
      title: "feat: add feature",
      body: "Adds the feature.",
      state: "merged",
      baseBranch: "main",
      headBranch: "feature/x",
      mergedAt: new Date(),
      number: 1,
    });
    await db.insert(pullRequests).values({
      repositoryId,
      authorId: userId,
      title: "fix: handle null case",
      body: "Crash fix.",
      state: "merged",
      baseBranch: "main",
      headBranch: "fix/y",
      mergedAt: new Date(),
      number: 2,
    });
  });

  afterAll(async () => {
    // Cleanup — cascades handle PRs / releases.
    if (repositoryId) {
      await db.delete(repositories).where(eq(repositories.id, repositoryId));
    }
    if (userId) {
      await db.delete(users).where(eq(users.id, userId));
    }
  });

  it("cross-references PRs from the commit range", async () => {
    const fromSha = await resolveRef(OWNER, REPO, "v1.0.0");
    expect(fromSha).toBeTruthy();
    expect(toSha).toBeTruthy();
    const { commitsBetween } = await import("../git/repository");
    const commits = await commitsBetween(OWNER, REPO, fromSha, toSha);
    expect(commits.length).toBe(2);

    const prs = await resolvePrsForCommits(repositoryId, commits);
    expect(prs.length).toBe(2);
    const nums = prs.map((p) => p.number).sort();
    expect(nums).toEqual([1, 2]);
  });

  it("renders structured output into markdown with section grouping", async () => {
    const claudeOut = JSON.stringify({
      headline: "Feature + fix.",
      summary: "Adds the new feature and patches the null crash.",
      sections: {
        features: { bullets: ["Add feature (#1) — @" + OWNER] },
        fixes: { bullets: ["Handle null (#2) — @" + OWNER] },
      },
    });

    const result = await generateReleaseNotes({
      repositoryId,
      fromTag: "v1.0.0",
      toTag: "v1.1.0",
      client: fakeClient(claudeOut),
    });

    expect(result.aiUsed).toBe(true);
    expect(result.prCount).toBe(2);
    expect(result.headline).toBe("Feature + fix.");
    expect(result.summary).toContain("Adds the new feature");
    expect(result.sections.features.bullets.length).toBe(1);
    expect(result.sections.fixes.bullets.length).toBe(1);
    expect(result.markdown).toContain("## v1.1.0 (since v1.0.0)");
    expect(result.markdown).toContain("**Feature + fix.**");
    expect(result.markdown).toContain("### Features");
    expect(result.markdown).toContain("### Bug fixes");
    expect(result.markdown).toContain("Add feature (#1)");
  });

  it("falls back to deterministic markdown when Claude returns garbage", async () => {
    const result = await generateReleaseNotes({
      repositoryId,
      fromTag: "v1.0.0",
      toTag: "v1.1.0",
      client: fakeClient("not json at all"),
    });
    expect(result.aiUsed).toBe(false);
    // Even without Claude, sections must be populated from the PR cross-ref.
    expect(result.sections.features.bullets.length).toBeGreaterThan(0);
    expect(result.sections.fixes.bullets.length).toBeGreaterThan(0);
    expect(result.markdown).toContain("### Features");
    expect(result.markdown).toContain("### Bug fixes");
  });

  it("returns a non-empty markdown even when no PRs match", async () => {
    // Generate notes for the initial-tag → initial-tag range (no commits).
    const result = await generateReleaseNotes({
      repositoryId,
      fromTag: "v1.0.0",
      toTag: "v1.0.0",
      client: fakeClient("{}"),
    });
    expect(result.markdown).toContain("v1.0.0");
    expect(result.prCount).toBe(0);
  });
});

describe("generateReleaseNotes — repo not found", () => {
  it("returns a graceful fallback for an unknown repository id", async () => {
    const result = await generateReleaseNotes({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      fromTag: null,
      toTag: "v1.0.0",
    });
    expect(result.prCount).toBe(0);
    expect(result.aiUsed).toBe(false);
    expect(result.markdown).toContain("v1.0.0");
  });
});
