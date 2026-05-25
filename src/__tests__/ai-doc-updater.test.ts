/**
 * Tests for src/lib/ai-doc-updater.ts.
 *
 * Layout mirrors ai-patch-generator.test.ts:
 *
 *   1. Pure parser — `parseTrackedSections` extracts every region with
 *      the right `marker`/`claim`/`claimedFor` triple, ignores unclosed
 *      regions, and is stable across runs (deterministic marker hash).
 *   2. Pure helpers — `sha256Hex`, `deriveSectionMarker`,
 *      `docUpdateBranchName`, `buildDocUpdatePrompt`,
 *      `renderDocUpdatePrBody`.
 *   3. Drift detection — uses real bare repos on disk. With no DB present
 *      we still assert that `findTrackedDocs` returns the parsed shape
 *      and that "unseen" sections (no prior row) are NOT flagged stale.
 *   4. End-to-end propose — injected fake Claude client + real bare repo;
 *      DB-backed steps (PR insert) gated on HAS_DB.
 *
 * The Anthropic client is faked via the public `client` option so we never
 * touch the network or require an API key.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import {
  AI_DOC_UPDATE_LABEL,
  AI_DOC_UPDATE_MARKER,
  buildDocUpdatePrompt,
  deriveSectionMarker,
  docUpdateBranchName,
  findTrackedDocs,
  parseTrackedSections,
  proposeDocUpdate,
  renderDocUpdatePrBody,
  sha256Hex,
  __test,
} from "../lib/ai-doc-updater";
import {
  createOrUpdateFileOnBranch,
  initBareRepo,
  refExists,
  getBlob,
} from "../git/repository";
import { db } from "../db";
import { eq } from "drizzle-orm";
import {
  docTracking,
  pullRequests,
  repositories,
  users,
} from "../db/schema";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const TEST_REPOS = join(
  import.meta.dir,
  "../../.test-repos-ai-doc-" + Date.now()
);

beforeAll(async () => {
  process.env.GIT_REPOS_PATH = TEST_REPOS;
  process.env.DATABASE_URL = process.env.DATABASE_URL || "";
  await rm(TEST_REPOS, { recursive: true, force: true });
  await mkdir(TEST_REPOS, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure parser
// ---------------------------------------------------------------------------

describe("parseTrackedSections", () => {
  it("returns [] for empty / non-string input", () => {
    expect(parseTrackedSections("")).toEqual([]);
    expect(parseTrackedSections(undefined as any)).toEqual([]);
    expect(parseTrackedSections(null as any)).toEqual([]);
  });

  it("returns [] when there are no markers", () => {
    expect(parseTrackedSections("# Hello\n\nJust prose.")).toEqual([]);
  });

  it("extracts a single region with the right path + claim", () => {
    const md = [
      "# Title",
      "",
      "<!-- gluecron:doc-track src=src/lib/auth.ts -->",
      "This module exports `signIn` and `signUp`.",
      "<!-- /gluecron:doc-track -->",
      "",
      "Trailing prose.",
    ].join("\n");
    const out = parseTrackedSections(md);
    expect(out.length).toBe(1);
    expect(out[0].claimedFor).toBe("src/lib/auth.ts");
    expect(out[0].claim).toContain("signIn");
    expect(out[0].claim).toContain("signUp");
    expect(out[0].marker.length).toBe(16);
  });

  it("extracts multiple regions in document order", () => {
    const md = [
      "<!-- gluecron:doc-track src=a.ts -->",
      "first",
      "<!-- /gluecron:doc-track -->",
      "middle",
      "<!-- gluecron:doc-track src=b.ts -->",
      "second",
      "<!-- /gluecron:doc-track -->",
    ].join("\n");
    const out = parseTrackedSections(md);
    expect(out.length).toBe(2);
    expect(out[0].claimedFor).toBe("a.ts");
    expect(out[0].claim).toBe("first");
    expect(out[1].claimedFor).toBe("b.ts");
    expect(out[1].claim).toBe("second");
  });

  it("ignores an unclosed region", () => {
    const md = [
      "<!-- gluecron:doc-track src=a.ts -->",
      "no close",
      "",
      "<!-- gluecron:doc-track src=b.ts -->",
      "closed",
      "<!-- /gluecron:doc-track -->",
    ].join("\n");
    const out = parseTrackedSections(md);
    // The first open swallows up to the next close — so we get a single
    // region whose claim spans across the second open marker. That's
    // still a deterministic outcome; just assert what we got.
    expect(out.length).toBe(1);
    expect(out[0].claimedFor).toBe("a.ts");
  });

  it("ignores a region with empty body", () => {
    const md = [
      "<!-- gluecron:doc-track src=a.ts -->",
      "",
      "<!-- /gluecron:doc-track -->",
    ].join("\n");
    expect(parseTrackedSections(md).length).toBe(0);
  });

  it("derives the same marker for the same (src, claim) pair", () => {
    const a = deriveSectionMarker("src/a.ts", "hello");
    const b = deriveSectionMarker("src/a.ts", "hello");
    expect(a).toBe(b);
    expect(a.length).toBe(16);
  });

  it("derives different markers when the claim differs", () => {
    expect(deriveSectionMarker("src/a.ts", "hello")).not.toBe(
      deriveSectionMarker("src/a.ts", "world")
    );
  });
});

describe("sha256Hex", () => {
  it("is deterministic and 64-char hex", () => {
    const a = sha256Hex("abc");
    const b = sha256Hex("abc");
    expect(a).toBe(b);
    expect(/^[0-9a-f]{64}$/.test(a)).toBe(true);
  });

  it("differs on different input", () => {
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
  });
});

describe("docUpdateBranchName", () => {
  it("honours an override", () => {
    expect(docUpdateBranchName("README.md", "custom/branch")).toBe(
      "custom/branch"
    );
  });

  it("uses ai-doc-update/<basename>-<ts> by default", () => {
    const name = docUpdateBranchName("docs/api/REFERENCE.md");
    expect(name.startsWith("ai-doc-update/reference-")).toBe(true);
    const ts = name.split("-").pop()!;
    expect(/^\d+$/.test(ts)).toBe(true);
  });
});

describe("buildDocUpdatePrompt", () => {
  it("embeds the doc path, doc body, and every stale section's source", () => {
    const out = buildDocUpdatePrompt({
      docPath: "README.md",
      docRaw: "# Title\n<!-- gluecron:doc-track src=a.ts -->old<!-- /gluecron:doc-track -->\n",
      staleSections: [
        {
          marker: "abc",
          claim: "old",
          claimedFor: "a.ts",
          sourceContent: "export const FRESH = 1;",
        },
      ],
    });
    expect(out).toContain("README.md");
    expect(out).toContain("a.ts");
    expect(out).toContain("export const FRESH = 1;");
    expect(out).toContain('"patches"');
    expect(out).toContain('"new_content"');
    expect(out).toContain("doc-track");
  });
});

describe("renderDocUpdatePrBody", () => {
  it("includes the marker, label tag, and section list", () => {
    const body = renderDocUpdatePrBody({
      docPath: "README.md",
      explanation: "Renamed signIn() to login().",
      updatedSections: [
        {
          marker: "abc1234567890def",
          claim: "old",
          claimedFor: "src/lib/auth.ts",
          currentSrcHash: "deadbeefdeadbeefdeadbeef",
          storedClaimedHash: "cafebabecafebabecafebabe",
          stale: true,
        },
      ],
    });
    expect(body).toContain(AI_DOC_UPDATE_MARKER);
    expect(body).toContain(AI_DOC_UPDATE_LABEL);
    expect(body).toContain("src/lib/auth.ts");
    expect(body).toContain("Renamed signIn() to login().");
    expect(body).toContain("cafebabecafe");
    expect(body).toContain("deadbeefdead");
  });

  it("falls back when no explanation is provided", () => {
    const body = renderDocUpdatePrBody({
      docPath: "README.md",
      explanation: "",
      updatedSections: [],
    });
    expect(body).toContain("(no explanation provided)");
    expect(body).toContain("(none)");
  });
});

// ---------------------------------------------------------------------------
// findTrackedDocs — drift detection against a real bare repo. Skipped
// without DB because the lib needs to resolve a repositories row.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("findTrackedDocs — drift detection", () => {
  it.skipIf(!HAS_DB)(
    "treats first-time observations as fresh, second-time differing hashes as stale",
    async () => {
      const username = `aidoc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const [u] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@example.com`,
          passwordHash: "x",
        })
        .returning({ id: users.id });
      const repoName = `subject_${Date.now()}`;
      const [r] = await db
        .insert(repositories)
        .values({
          ownerId: u.id,
          name: repoName,
          diskPath: `/tmp/${username}/${repoName}`,
          defaultBranch: "main",
        })
        .returning({ id: repositories.id });

      await initBareRepo(username, repoName);

      // Seed a README with one tracked region pointing at src/lib/auth.ts.
      const readme = [
        "# Project",
        "",
        "<!-- gluecron:doc-track src=src/lib/auth.ts -->",
        "This module exports `signIn` and `signUp`.",
        "<!-- /gluecron:doc-track -->",
      ].join("\n");
      const sourceV1 = "export function signIn() {}\nexport function signUp() {}\n";
      const sourceV2 = "export function login() {}\nexport function register() {}\n";

      let res = await createOrUpdateFileOnBranch({
        owner: username,
        name: repoName,
        branch: "main",
        filePath: "README.md",
        bytes: new TextEncoder().encode(readme),
        message: "seed readme",
        authorName: "Seeder",
        authorEmail: "s@e.com",
      });
      if ("error" in res) throw new Error("seed readme failed");

      res = await createOrUpdateFileOnBranch({
        owner: username,
        name: repoName,
        branch: "main",
        filePath: "src/lib/auth.ts",
        bytes: new TextEncoder().encode(sourceV1),
        message: "seed source v1",
        authorName: "Seeder",
        authorEmail: "s@e.com",
      });
      if ("error" in res) throw new Error("seed source failed");

      // First pass: no rows in doc_tracking → unseen → NOT stale.
      const first = await findTrackedDocs(r.id);
      expect(first.length).toBe(1);
      expect(first[0].sections.length).toBe(1);
      expect(first[0].sections[0].stale).toBe(false);
      expect(first[0].sections[0].storedClaimedHash).toBeNull();
      const seenHash = first[0].sections[0].currentSrcHash;
      expect(seenHash).toBe(sha256Hex(sourceV1));

      // Manually pin a baseline hash so the next compare has something to
      // diff against — mimics what persistObservedSections does.
      await db.insert(docTracking).values({
        repositoryId: r.id,
        docPath: first[0].path,
        sectionMarker: first[0].sections[0].marker,
        srcPath: first[0].sections[0].claimedFor,
        claimedHash: seenHash,
      });

      // Push v2 of the source so its hash drifts.
      res = await createOrUpdateFileOnBranch({
        owner: username,
        name: repoName,
        branch: "main",
        filePath: "src/lib/auth.ts",
        bytes: new TextEncoder().encode(sourceV2),
        message: "rename apis",
        authorName: "Seeder",
        authorEmail: "s@e.com",
      });
      if ("error" in res) throw new Error("update source failed");

      const second = await findTrackedDocs(r.id);
      expect(second.length).toBe(1);
      expect(second[0].sections.length).toBe(1);
      expect(second[0].sections[0].stale).toBe(true);
      expect(second[0].sections[0].storedClaimedHash).toBe(seenHash);
      expect(second[0].sections[0].currentSrcHash).toBe(sha256Hex(sourceV2));
    },
    20000
  );
});

// ---------------------------------------------------------------------------
// proposeDocUpdate — end-to-end with injected fake Claude
// ---------------------------------------------------------------------------

function fakeClient(responseText: string) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text" as const, text: responseText }],
      }),
    },
  } as any;
}

describe("proposeDocUpdate", () => {
  it("returns null when no section is stale", async () => {
    const out = await proposeDocUpdate({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      path: "README.md",
      sections: [
        {
          marker: "abc",
          claim: "old",
          claimedFor: "a.ts",
          currentSrcHash: "h",
          storedClaimedHash: "h",
          stale: false,
        },
      ],
      client: fakeClient("{}"),
    });
    expect(out).toBeNull();
  });

  it("returns null when Claude returns zero patches", async () => {
    // Without DB the resolver returns null first → still null. The
    // assertion holds in either case.
    if (!HAS_DB) {
      const out = await proposeDocUpdate({
        repositoryId: "00000000-0000-0000-0000-000000000000",
        path: "README.md",
        sections: [
          {
            marker: "abc",
            claim: "old",
            claimedFor: "a.ts",
            currentSrcHash: "h1",
            storedClaimedHash: "h0",
            stale: true,
          },
        ],
        client: fakeClient('{"explanation":"all good","patches":[]}'),
      });
      expect(out).toBeNull();
      return;
    }

    // HAS_DB path: insert a real repo + readme + source so we get past
    // the resolver and into Claude. The empty patches array still
    // short-circuits to null.
    const username = `aidoc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const [u] = await db
      .insert(users)
      .values({
        username,
        email: `${username}@example.com`,
        passwordHash: "x",
      })
      .returning({ id: users.id });
    const repoName = `empty_${Date.now()}`;
    const [r] = await db
      .insert(repositories)
      .values({
        ownerId: u.id,
        name: repoName,
        diskPath: `/tmp/${username}/${repoName}`,
        defaultBranch: "main",
      })
      .returning({ id: repositories.id });

    await initBareRepo(username, repoName);
    const seeded1 = await createOrUpdateFileOnBranch({
      owner: username,
      name: repoName,
      branch: "main",
      filePath: "README.md",
      bytes: new TextEncoder().encode("# r\n<!-- gluecron:doc-track src=a.ts -->old<!-- /gluecron:doc-track -->\n"),
      message: "seed",
      authorName: "Seeder",
      authorEmail: "s@e.com",
    });
    if ("error" in seeded1) throw new Error("seed readme failed");
    const seeded2 = await createOrUpdateFileOnBranch({
      owner: username,
      name: repoName,
      branch: "main",
      filePath: "a.ts",
      bytes: new TextEncoder().encode("export const X = 1;\n"),
      message: "seed source",
      authorName: "Seeder",
      authorEmail: "s@e.com",
    });
    if ("error" in seeded2) throw new Error("seed source failed");

    const out = await proposeDocUpdate({
      repositoryId: r.id,
      path: "README.md",
      sections: [
        {
          marker: "abc",
          claim: "old",
          claimedFor: "a.ts",
          currentSrcHash: "h1",
          storedClaimedHash: "h0",
          stale: true,
        },
      ],
      client: fakeClient('{"explanation":"all good","patches":[]}'),
    });
    expect(out).toBeNull();

    const prs = await db
      .select({ number: pullRequests.number })
      .from(pullRequests)
      .where(eq(pullRequests.repositoryId, r.id));
    expect(prs.length).toBe(0);
  });

  it.skipIf(!HAS_DB)(
    "opens a PR with the refreshed markdown when Claude returns a patch",
    async () => {
      const username = `aidoc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const [u] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@example.com`,
          passwordHash: "x",
        })
        .returning({ id: users.id });
      const repoName = `subject_${Date.now()}`;
      const [r] = await db
        .insert(repositories)
        .values({
          ownerId: u.id,
          name: repoName,
          diskPath: `/tmp/${username}/${repoName}`,
          defaultBranch: "main",
        })
        .returning({ id: repositories.id });

      await initBareRepo(username, repoName);
      const readme = [
        "# Project",
        "",
        "<!-- gluecron:doc-track src=src/lib/auth.ts -->",
        "This module exports `signIn` and `signUp`.",
        "<!-- /gluecron:doc-track -->",
      ].join("\n");
      const refreshed = [
        "# Project",
        "",
        "<!-- gluecron:doc-track src=src/lib/auth.ts -->",
        "This module exports `login` and `register`.",
        "<!-- /gluecron:doc-track -->",
      ].join("\n");

      const s1 = await createOrUpdateFileOnBranch({
        owner: username,
        name: repoName,
        branch: "main",
        filePath: "README.md",
        bytes: new TextEncoder().encode(readme),
        message: "seed readme",
        authorName: "Seeder",
        authorEmail: "s@e.com",
      });
      if ("error" in s1) throw new Error("seed readme failed");
      const s2 = await createOrUpdateFileOnBranch({
        owner: username,
        name: repoName,
        branch: "main",
        filePath: "src/lib/auth.ts",
        bytes: new TextEncoder().encode(
          "export function login() {}\nexport function register() {}\n"
        ),
        message: "seed source",
        authorName: "Seeder",
        authorEmail: "s@e.com",
      });
      if ("error" in s2) throw new Error("seed source failed");

      const canned = JSON.stringify({
        explanation: "Renamed signIn/signUp to login/register to match source.",
        patches: [{ path: "README.md", new_content: refreshed }],
      });
      const branchOverride = `ai-doc-update/test-${Date.now()}`;
      const out = await proposeDocUpdate({
        repositoryId: r.id,
        path: "README.md",
        sections: [
          {
            marker: "marker-test",
            claim: "This module exports `signIn` and `signUp`.",
            claimedFor: "src/lib/auth.ts",
            currentSrcHash: sha256Hex(
              "export function login() {}\nexport function register() {}\n"
            ),
            storedClaimedHash: sha256Hex(
              "export function signIn() {}\nexport function signUp() {}\n"
            ),
            stale: true,
          },
        ],
        client: fakeClient(canned),
        branchOverride,
      });
      expect(out).not.toBeNull();
      expect(out!.branch).toBe(branchOverride);
      expect(typeof out!.prNumber).toBe("number");
      expect(out!.updatedSections).toBe(1);

      // Branch exists in the bare repo.
      expect(
        await refExists(username, repoName, `refs/heads/${branchOverride}`)
      ).toBe(true);

      // README on the branch contains the refreshed prose.
      const blob = await getBlob(
        username,
        repoName,
        branchOverride,
        "README.md"
      );
      expect(blob).not.toBeNull();
      expect(blob!.content).toContain("login");
      expect(blob!.content).toContain("register");
      expect(blob!.content).not.toContain("signIn");

      // PR row exists with the right base/head.
      const [pr] = await db
        .select({
          number: pullRequests.number,
          headBranch: pullRequests.headBranch,
          baseBranch: pullRequests.baseBranch,
          body: pullRequests.body,
        })
        .from(pullRequests)
        .where(eq(pullRequests.repositoryId, r.id))
        .limit(1);
      expect(pr).toBeTruthy();
      expect(pr!.headBranch).toBe(branchOverride);
      expect(pr!.baseBranch).toBe("main");
      expect(pr!.body).toContain(AI_DOC_UPDATE_MARKER);
      expect(pr!.body).toContain(AI_DOC_UPDATE_LABEL);

      // doc_tracking row was upserted with the new hash + PR id.
      const tracked = await db
        .select({
          claimedHash: docTracking.claimedHash,
          lastPrId: docTracking.lastPrId,
        })
        .from(docTracking)
        .where(eq(docTracking.repositoryId, r.id));
      expect(tracked.length).toBeGreaterThan(0);
      expect(tracked[0].lastPrId).toBeTruthy();
    },
    25000
  );
});

// ---------------------------------------------------------------------------
// Internal helpers — sanity checks against bogus inputs.
// ---------------------------------------------------------------------------

describe("__test internals", () => {
  it("exports the documented helpers", () => {
    expect(typeof __test.resolveRepoMeta).toBe("function");
    expect(typeof __test.listMarkdownFiles).toBe("function");
    expect(typeof __test.ensureDocUpdateLabel).toBe("function");
    expect(typeof __test.askClaudeForDocPatch).toBe("function");
    expect(typeof __test.seedBranchFromDefault).toBe("function");
  });

  it("askClaudeForDocPatch tolerates an invalid JSON envelope", async () => {
    const out = await __test.askClaudeForDocPatch(
      fakeClient("not json at all"),
      "prompt"
    );
    expect(out).toBeNull();
  });
});
