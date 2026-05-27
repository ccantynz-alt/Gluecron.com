/**
 * Unit tests for src/lib/claude-web-session.ts.
 *
 * We don't exercise the real `claude` CLI here — the spawn seam is
 * overridden so we can verify the command shape, --resume passthrough,
 * stream-json session-id parsing, and the env-scrubbing whitelist.
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import {
  __setSpawnForTests,
  __test,
  claudeBinary,
  claudeWebRoot,
  runTurn,
  sessionWorkdir,
  type SpawnFn,
} from "../lib/claude-web-session";
import type { ClaudeWebSession } from "../db/schema";

const originalRoot = process.env.CLAUDE_WEB_WORKDIR;
const originalBin = process.env.CLAUDE_BIN;
const originalApiKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  process.env.CLAUDE_WEB_WORKDIR = "/tmp/cw-test";
  process.env.CLAUDE_BIN = "claude-test";
});

afterEach(() => {
  __setSpawnForTests(null);
  for (const [k, v] of [
    ["CLAUDE_WEB_WORKDIR", originalRoot],
    ["CLAUDE_BIN", originalBin],
    ["ANTHROPIC_API_KEY", originalApiKey],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function fakeSession(overrides: Partial<ClaudeWebSession> = {}): ClaudeWebSession {
  return {
    id: "00000000-0000-0000-0000-000000000099",
    repositoryId: "00000000-0000-0000-0000-000000000001",
    ownerUserId: "00000000-0000-0000-0000-000000000002",
    title: "test session",
    branch: "main",
    workdirPath: "/tmp/cw-test/00000000-0000-0000-0000-000000000099",
    claudeSessionId: null,
    status: "cold",
    lastActiveAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  } as ClaudeWebSession;
}

describe("claudeWebRoot + sessionWorkdir + claudeBinary", () => {
  it("reads from env at call time", () => {
    expect(claudeWebRoot()).toBe("/tmp/cw-test");
    expect(claudeBinary()).toBe("claude-test");
    expect(sessionWorkdir("abc")).toBe("/tmp/cw-test/abc");
  });

  it("defaults sensibly when env unset", () => {
    delete process.env.CLAUDE_WEB_WORKDIR;
    delete process.env.CLAUDE_BIN;
    expect(claudeWebRoot()).toBe("/var/lib/gluecron/claude-web");
    expect(claudeBinary()).toBe("claude");
  });

  it("strips trailing slash from workdir root", () => {
    process.env.CLAUDE_WEB_WORKDIR = "/tmp/cw-test/";
    expect(claudeWebRoot()).toBe("/tmp/cw-test");
  });
});

describe("runTurn", () => {
  it("invokes the claude binary with --print and prompt, without --resume on first turn", async () => {
    const captured: { cmd: string[]; cwd: string } = { cmd: [], cwd: "" };
    const handle = makeHandle(['{"type":"text","text":"hi"}\n'], 0, "");
    __setSpawnForTests((cmd, opts) => {
      captured.cmd = cmd;
      captured.cwd = opts.cwd;
      return handle;
    });

    const events = await collect(runTurn({
      session: fakeSession(),
      ownerName: "you",
      repoName: "repo",
      prompt: "hello there",
    }));

    expect(captured.cmd[0]).toBe("claude-test");
    expect(captured.cmd).toContain("--print");
    expect(captured.cmd).toContain("--output-format");
    expect(captured.cmd).toContain("stream-json");
    expect(captured.cmd).not.toContain("--resume");
    expect(captured.cmd[captured.cmd.length - 1]).toBe("hello there");
    expect(captured.cwd).toBe("/tmp/cw-test/00000000-0000-0000-0000-000000000099");

    const chunks = events.filter((e) => e.chunk).map((e) => e.chunk).join("");
    expect(chunks).toContain("hi");
    const done = events.find((e) => e.done);
    expect(done?.done?.exitCode).toBe(0);
  });

  it("passes --resume <id> when the session already has a claudeSessionId", async () => {
    const captured: { cmd: string[] } = { cmd: [] };
    __setSpawnForTests((cmd) => {
      captured.cmd = cmd;
      return makeHandle(["ok\n"], 0, "");
    });

    await collect(runTurn({
      session: fakeSession({
        claudeSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
      ownerName: "you",
      repoName: "repo",
      prompt: "next turn",
    }));

    const i = captured.cmd.indexOf("--resume");
    expect(i).toBeGreaterThan(-1);
    expect(captured.cmd[i + 1]).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("extracts the Claude session UUID from a stream-json init chunk", async () => {
    __setSpawnForTests(() =>
      makeHandle(
        [
          '{"type":"system","subtype":"init","session_id":"12345678-aaaa-bbbb-cccc-1234567890ab"}\n',
          '{"type":"text","text":"hello"}\n',
        ],
        0,
        ""
      )
    );
    const events = await collect(runTurn({
      session: fakeSession(),
      ownerName: "you",
      repoName: "repo",
      prompt: "p",
    }));
    const done = events.find((e) => e.done);
    expect(done?.done?.claudeSessionId).toBe(
      "12345678-aaaa-bbbb-cccc-1234567890ab"
    );
  });

  it("returns the subprocess exit code on the done event", async () => {
    __setSpawnForTests(() => makeHandle(["x"], 7, "boom"));
    const events = await collect(runTurn({
      session: fakeSession(),
      ownerName: "y",
      repoName: "r",
      prompt: "p",
    }));
    const done = events.find((e) => e.done);
    expect(done?.done?.exitCode).toBe(7);
    expect(done?.done?.stderr).toBe("boom");
  });
});

describe("passthroughEnv", () => {
  it("keeps PATH and ANTHROPIC_API_KEY when set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const env = __test.passthroughEnv();
    expect(env.PATH).toBeDefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  it("strips DATABASE_URL even if set", () => {
    process.env.DATABASE_URL = "postgresql://x";
    const env = __test.passthroughEnv();
    expect(env.DATABASE_URL).toBeUndefined();
    delete process.env.DATABASE_URL;
  });

  it("keeps any CLAUDE_* prefix var", () => {
    process.env.CLAUDE_CUSTOM_FLAG = "yes";
    const env = __test.passthroughEnv();
    expect(env.CLAUDE_CUSTOM_FLAG).toBe("yes");
    delete process.env.CLAUDE_CUSTOM_FLAG;
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function makeHandle(
  chunks: string[],
  exitCode: number,
  stderr: string
): ReturnType<SpawnFn> {
  return {
    stdout: (async function* () {
      for (const c of chunks) yield c;
    })(),
    done: Promise.resolve({ exitCode, stderr }),
    kill: () => {},
  };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}
