/**
 * Tests for the task → model router in src/lib/ai-client.ts.
 *
 * Routing policy under test:
 *   - Only the light, human-reviewed tasks (commit-message, issue-triage,
 *     pr-triage, label-suggest) may run on Haiku.
 *   - Everything that writes or judges code — and any unknown task —
 *     defaults to Sonnet.
 *   - AI_FORCE_SONNET=1 is an instant kill-switch that forces Sonnet for
 *     every task, read from the environment at call time.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  modelForTask,
  MODEL_SONNET,
  MODEL_HAIKU,
  type AiTask,
} from "../lib/ai-client";

const ORIGINAL_FORCE_SONNET = process.env.AI_FORCE_SONNET;

afterEach(() => {
  // Restore whatever the environment had before the suite ran.
  if (ORIGINAL_FORCE_SONNET === undefined) {
    delete process.env.AI_FORCE_SONNET;
  } else {
    process.env.AI_FORCE_SONNET = ORIGINAL_FORCE_SONNET;
  }
});

// ──────────────────────────── Haiku allowlist ────────────────────────────

describe("modelForTask — Haiku allowlist", () => {
  const haikuTasks: AiTask[] = [
    "commit-message",
    "issue-triage",
    "pr-triage",
    "label-suggest",
  ];

  for (const task of haikuTasks) {
    it(`routes ${task} to Haiku`, () => {
      delete process.env.AI_FORCE_SONNET;
      expect(modelForTask(task)).toBe(MODEL_HAIKU);
    });
  }
});

// ──────────────────────────── Sonnet defaults ────────────────────────────

describe("modelForTask — code-critical and doc tasks stay on Sonnet", () => {
  const sonnetTasks: AiTask[] = [
    "code-review",
    "code-completion",
    "spec-to-pr",
    "ci-heal",
    "pr-summary",
    "changelog",
  ];

  for (const task of sonnetTasks) {
    it(`routes ${task} to Sonnet`, () => {
      delete process.env.AI_FORCE_SONNET;
      expect(modelForTask(task)).toBe(MODEL_SONNET);
    });
  }

  it("defaults unknown tasks to Sonnet (never silently downgrades)", () => {
    delete process.env.AI_FORCE_SONNET;
    // Simulate a typo'd / future task name slipping past the type system.
    expect(modelForTask("some-future-task" as AiTask)).toBe(MODEL_SONNET);
    expect(modelForTask("" as AiTask)).toBe(MODEL_SONNET);
  });
});

// ──────────────────────────── kill-switch ────────────────────────────

describe("modelForTask — AI_FORCE_SONNET kill-switch", () => {
  const allTasks: AiTask[] = [
    "commit-message",
    "issue-triage",
    "pr-triage",
    "label-suggest",
    "code-review",
    "code-completion",
    "spec-to-pr",
    "ci-heal",
    "pr-summary",
    "changelog",
  ];

  it("forces Sonnet for every task when AI_FORCE_SONNET=1", () => {
    process.env.AI_FORCE_SONNET = "1";
    for (const task of allTasks) {
      expect(modelForTask(task)).toBe(MODEL_SONNET);
    }
  });

  it("is read at call time — flipping the env var takes effect immediately", () => {
    delete process.env.AI_FORCE_SONNET;
    expect(modelForTask("commit-message")).toBe(MODEL_HAIKU);

    process.env.AI_FORCE_SONNET = "1";
    expect(modelForTask("commit-message")).toBe(MODEL_SONNET);

    delete process.env.AI_FORCE_SONNET;
    expect(modelForTask("commit-message")).toBe(MODEL_HAIKU);
  });

  it("only the exact value \"1\" activates the kill-switch", () => {
    process.env.AI_FORCE_SONNET = "0";
    expect(modelForTask("commit-message")).toBe(MODEL_HAIKU);

    process.env.AI_FORCE_SONNET = "";
    expect(modelForTask("commit-message")).toBe(MODEL_HAIKU);
  });
});
