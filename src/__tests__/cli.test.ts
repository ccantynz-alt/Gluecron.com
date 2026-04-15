/**
 * Block G3 — `gluecron` CLI smoke tests.
 *
 * Invokes the `dispatch` function directly without spawning a process;
 * captures stdout lines via an injected `out` callback. This keeps the
 * tests hermetic — no actual HTTP requests (except in cases where they
 * are expected to fail gracefully against a non-responsive host).
 */

import { describe, it, expect } from "bun:test";
import { dispatch, HELP, loadConfig } from "../../cli/gluecron";

function capture() {
  const lines: string[] = [];
  return {
    out: (s: string) => lines.push(s),
    text: () => lines.join("\n"),
    lines,
  };
}

describe("cli — help + version", () => {
  it("prints help on no args", async () => {
    const { out, text } = capture();
    const code = await dispatch([], out);
    expect(code).toBe(0);
    expect(text()).toContain("gluecron CLI");
  });

  it("prints help with --help", async () => {
    const { out, text } = capture();
    const code = await dispatch(["--help"], out);
    expect(code).toBe(0);
    expect(text()).toContain("Usage");
  });

  it("prints version with --version", async () => {
    const { out, text } = capture();
    const code = await dispatch(["--version"], out);
    expect(code).toBe(0);
    expect(text()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("rejects unknown commands", async () => {
    const { out, text } = capture();
    const code = await dispatch(["bogus"], out);
    expect(code).toBe(1);
    expect(text()).toContain("unknown command");
  });
});

describe("cli — config", () => {
  it("loadConfig returns default host when no file exists", () => {
    const cfg = loadConfig();
    expect(cfg.host).toBeDefined();
    expect(typeof cfg.host).toBe("string");
  });
});

describe("cli — HELP text", () => {
  it("lists every major command", () => {
    expect(HELP).toContain("login");
    expect(HELP).toContain("whoami");
    expect(HELP).toContain("repo ls");
    expect(HELP).toContain("repo show");
    expect(HELP).toContain("repo create");
    expect(HELP).toContain("issues ls");
    expect(HELP).toContain("gql");
  });
});

describe("cli — dispatcher", () => {
  it("repo with no subcommand prints usage", async () => {
    const { out, text } = capture();
    const code = await dispatch(["repo"], out);
    expect(code).toBe(1);
    expect(text()).toContain("usage:");
  });

  it("issues without args prints usage", async () => {
    const { out, text } = capture();
    const code = await dispatch(["issues"], out);
    expect(code).toBe(1);
    expect(text()).toContain("usage:");
  });

  it("gql without query prints usage", async () => {
    const { out, text } = capture();
    const code = await dispatch(["gql"], out);
    expect(code).toBe(1);
    expect(text()).toContain("usage:");
  });
});
