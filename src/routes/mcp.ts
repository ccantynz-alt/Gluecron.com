/**
 * Model Context Protocol HTTP transport.
 *
 *   POST /mcp        — JSON-RPC 2.0 requests; body is a single request
 *                       or an array (batch). Response shape mirrors.
 *   GET  /mcp        — Lightweight discovery: returns server info +
 *                       protocol version + tool count.
 *
 * Auth: softAuth — `userId` in the McpContext is the cookie/PAT/OAuth
 * user when present, null otherwise. v1 tools are read-only and public-
 * only, so anonymous works; write tools (v2) will require requireAuth +
 * write-access on the target repo.
 *
 * Streamable-HTTP-mode is the recommended MCP transport for stateless
 * cloud servers. We don't emit server-sent notifications yet, so the
 * route is plain JSON in / JSON out.
 */

import { Hono } from "hono";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  routeMcpRequest,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
} from "../lib/mcp";
import { defaultTools } from "../lib/mcp-tools";

const mcp = new Hono<AuthEnv>();

mcp.use("*", softAuth);

mcp.get("/mcp", (c) => {
  const tools = defaultTools();
  return c.json({
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    transport: "http",
    toolCount: Object.keys(tools).length,
    docs:
      "POST /mcp with a JSON-RPC 2.0 envelope to call. See https://spec.modelcontextprotocol.io/",
  });
});

mcp.post("/mcp", async (c) => {
  const user = c.get("user") ?? null;
  const ctx = { userId: user?.id ?? null };
  const tools = defaultTools();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      400
    );
  }

  if (Array.isArray(body)) {
    // Batched request — pass each through, drop nulls (notifications).
    const out = await Promise.all(
      body.map((entry) => routeMcpRequest(entry, { ctx, tools }))
    );
    const filtered = out.filter((r): r is NonNullable<typeof r> => r !== null);
    if (filtered.length === 0) return c.body(null, 204);
    return c.json(filtered);
  }

  const result = await routeMcpRequest(body, { ctx, tools });
  if (result === null) {
    // Notification — no response body, 204.
    return c.body(null, 204);
  }
  return c.json(result);
});

export default mcp;
