/**
 * Block K8 — Agent inbox + controls UI tests.
 *
 * Pure form-parser tests cover the allowlist + coercion logic.
 * Route smokes only assert auth behaviour — DB-backed flows live in
 * the integration suite.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  parseAgentSettingsForm,
  type AgentSettingsInput,
} from "../routes/agents";

describe("agents UI — parseAgentSettingsForm", () => {
  it("accepts a valid full form", () => {
    const parsed = parseAgentSettingsForm({
      enabled_kinds: ["triage", "fix"],
      daily_budget_cents: "500",
      monthly_budget_cents: "10000",
      max_runs_per_hour: "30",
      paused: "on",
    });
    expect(parsed.enabledKinds).toEqual(["triage", "fix"]);
    expect(parsed.dailyBudgetCents).toBe(500);
    expect(parsed.monthlyBudgetCents).toBe(10000);
    expect(parsed.maxRunsPerHour).toBe(30);
    expect(parsed.paused).toBe(true);
  });

  it("filters out unknown kinds", () => {
    const parsed = parseAgentSettingsForm({
      enabled_kinds: ["triage", "hacking", "DROP TABLE"],
    });
    expect(parsed.enabledKinds).toEqual(["triage"]);
  });

  it("uses defaults when form is empty", () => {
    const parsed = parseAgentSettingsForm({} as AgentSettingsInput);
    expect(parsed.enabledKinds).toEqual([]);
    expect(parsed.dailyBudgetCents).toBe(100);
    expect(parsed.monthlyBudgetCents).toBe(2000);
    expect(parsed.maxRunsPerHour).toBe(20);
    expect(parsed.paused).toBe(false);
  });

  it("rejects negative budgets (falls back to default)", () => {
    const parsed = parseAgentSettingsForm({
      daily_budget_cents: "-50",
      monthly_budget_cents: "-1000",
    });
    expect(parsed.dailyBudgetCents).toBe(100);
    expect(parsed.monthlyBudgetCents).toBe(2000);
  });

  it("caps over-large budgets", () => {
    const parsed = parseAgentSettingsForm({
      daily_budget_cents: "99999999",
      monthly_budget_cents: "99999999999",
      max_runs_per_hour: "99999",
    });
    expect(parsed.dailyBudgetCents).toBe(1_000_000);
    expect(parsed.monthlyBudgetCents).toBe(50_000_000);
    expect(parsed.maxRunsPerHour).toBe(1000);
  });

  it("accepts a single kind as a string (form single-select edge)", () => {
    const parsed = parseAgentSettingsForm({ enabled_kinds: "heal_bot" });
    expect(parsed.enabledKinds).toEqual(["heal_bot"]);
  });

  it("handles non-numeric budget gracefully", () => {
    const parsed = parseAgentSettingsForm({
      daily_budget_cents: "abc",
      max_runs_per_hour: "xyz",
    });
    expect(parsed.dailyBudgetCents).toBe(100);
    expect(parsed.maxRunsPerHour).toBe(20);
  });

  it("treats paused=true as true, paused=other as false", () => {
    expect(parseAgentSettingsForm({ paused: "true" }).paused).toBe(true);
    expect(parseAgentSettingsForm({ paused: "on" }).paused).toBe(true);
    expect(parseAgentSettingsForm({ paused: "off" }).paused).toBe(false);
    expect(parseAgentSettingsForm({ paused: "1" }).paused).toBe(false);
  });
});

describe("agents UI — route auth smokes", () => {
  it("POST /:owner/:repo/agents/:id/kill without session → 302 /login", async () => {
    const res = await app.fetch(
      new Request("http://test/alice/repo/agents/00000000-0000-0000-0000-000000000000/kill", {
        method: "POST",
      })
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });

  it("GET /:owner/:repo/settings/agents without session → 302 /login", async () => {
    const res = await app.fetch(
      new Request("http://test/alice/repo/settings/agents")
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });

  it("POST /:owner/:repo/settings/agents without session → 302 /login", async () => {
    const res = await app.fetch(
      new Request("http://test/alice/repo/settings/agents", {
        method: "POST",
        body: new URLSearchParams({ daily_budget_cents: "100" }),
      })
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });

  it("POST /:owner/:repo/settings/agents/pause without session → 302 /login", async () => {
    const res = await app.fetch(
      new Request("http://test/alice/repo/settings/agents/pause", {
        method: "POST",
      })
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });

  it("GET /admin/agents without session → 302 /login", async () => {
    const res = await app.fetch(new Request("http://test/admin/agents"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });

  it("POST /admin/agents/pause-all without session → 302 /login", async () => {
    const res = await app.fetch(
      new Request("http://test/admin/agents/pause-all", { method: "POST" })
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });
});
