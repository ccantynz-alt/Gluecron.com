/**
 * Tests for src/lib/mcp.ts (router) + src/lib/mcp-tools.ts (tools).
 *
 * The DB-touching tool runs require live Postgres; we focus on:
 *   - JSON-RPC envelope shape (initialize / tools/list / unknown method)
 *   - Notification handling (no `id` → no response)
 *   - tools/call validation (missing name, unknown tool)
 *   - Tool manifest shape (every default tool has a name + inputSchema)
 *   - Pure helper edge cases (argString / argNumber)
 *   - The HTTP route's discovery GET + JSON-RPC POST shape
 */

import { describe, it, expect } from "bun:test";
import {
  routeMcpRequest,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  ERR_METHOD_NOT_FOUND,
  ERR_INVALID_REQUEST,
  ERR_INVALID_PARAMS,
  McpError,
} from "../lib/mcp";
import { defaultTools, __test } from "../lib/mcp-tools";
import app from "../app";

const tools = defaultTools();
const ctx = { userId: null };

describe("routeMcpRequest — initialize", () => {
  it("returns the protocol version + server info", async () => {
    const r = await routeMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { ctx, tools }
    );
    expect(r).not.toBeNull();
    if (!r || "error" in r) throw new Error("expected success");
    const result = r.result as any;
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.serverInfo.name).toBe(MCP_SERVER_NAME);
    expect(result.capabilities.tools).toBeDefined();
  });
});

describe("routeMcpRequest — invalid input", () => {
  it("rejects a non-JSON-RPC envelope", async () => {
    const r = await routeMcpRequest({ method: "x" } as any, { ctx, tools });
    if (!r || "result" in r) throw new Error("expected error");
    expect(r.error.code).toBe(ERR_INVALID_REQUEST);
  });

  it("rejects an unknown method", async () => {
    const r = await routeMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "no_such_method" },
      { ctx, tools }
    );
    if (!r || "result" in r) throw new Error("expected error");
    expect(r.error.code).toBe(ERR_METHOD_NOT_FOUND);
  });

  it("returns null for a notification (no `id`)", async () => {
    const r = await routeMcpRequest(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { ctx, tools }
    );
    expect(r).toBeNull();
  });
});

describe("routeMcpRequest — tools/list", () => {
  it("returns the full tool manifest", async () => {
    const r = await routeMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { ctx, tools }
    );
    if (!r || "error" in r) throw new Error("expected success");
    const result = r.result as { tools: Array<{ name: string; inputSchema: any }> };
    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.tools.length).toBeGreaterThanOrEqual(4);
    for (const t of result.tools) {
      expect(typeof t.name).toBe("string");
      expect(t.name).toMatch(/^gluecron_/);
      expect(t.inputSchema.type).toBe("object");
    }
  });
});

describe("routeMcpRequest — tools/call validation", () => {
  it("rejects calls without a name", async () => {
    const r = await routeMcpRequest(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: {} },
      { ctx, tools }
    );
    if (!r || "result" in r) throw new Error("expected error");
    expect(r.error.code).toBe(ERR_INVALID_PARAMS);
  });

  it("rejects calls with an unknown tool name", async () => {
    const r = await routeMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "no_such_tool", arguments: {} },
      },
      { ctx, tools }
    );
    if (!r || "result" in r) throw new Error("expected error");
    expect(r.error.code).toBe(ERR_METHOD_NOT_FOUND);
  });
});

describe("argString / argNumber pure helpers", () => {
  it("returns the trimmed string when present", () => {
    expect(__test.argString({ x: "  hi  " }, "x")).toBe("hi");
  });

  it("falls back when missing", () => {
    expect(__test.argString({}, "x", "default")).toBe("default");
  });

  it("throws McpError when missing without fallback", () => {
    expect(() => __test.argString({}, "x")).toThrow(McpError);
  });

  it("argNumber accepts numeric strings", () => {
    expect(__test.argNumber({ n: "42" }, "n")).toBe(42);
  });

  it("argNumber falls back on non-numeric input", () => {
    expect(__test.argNumber({ n: "abc" }, "n", 7)).toBe(7);
  });
});

describe("tool manifest shape", () => {
  for (const handler of Object.values(tools)) {
    it(`${handler.tool.name} — required fields populated`, () => {
      expect(handler.tool.name).toMatch(/^gluecron_/);
      expect(typeof handler.tool.description).toBe("string");
      expect(handler.tool.description.length).toBeGreaterThan(10);
      expect(handler.tool.inputSchema.type).toBe("object");
      expect(typeof handler.tool.inputSchema.properties).toBe("object");
    });
  }
});

describe("HTTP route — GET /mcp discovery", () => {
  it("returns server info + tool count", async () => {
    const res = await app.request("/mcp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(body.serverInfo.name).toBe(MCP_SERVER_NAME);
    expect(body.toolCount).toBeGreaterThanOrEqual(4);
  });
});

describe("HTTP route — POST /mcp JSON-RPC", () => {
  it("answers initialize over the wire", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 204 for a single notification (no `id`)", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    expect(res.status).toBe(204);
  });

  it("supports a batched request", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body.length).toBe(2);
    expect(body[0].id).toBe(1);
    expect(body[1].id).toBe(2);
    expect(body[1].result.tools.length).toBeGreaterThanOrEqual(4);
  });
});
