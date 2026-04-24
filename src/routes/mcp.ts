/**
 * MCP (Model Context Protocol) HTTP endpoint — 2024-11-05 spec.
 *
 * Single endpoint: POST /mcp
 * Discovery:       GET  /mcp
 *
 * Authentication: Bearer token in the Authorization header.
 *   - Tokens prefixed `glc_`  → PAT (api_tokens table)
 *   - Tokens prefixed `glct_` → OAuth access token (oauth_access_tokens table)
 *   - No token → unauthenticated (only certain read-only methods are allowed)
 *
 * JSON-RPC 2.0 methods:
 *   initialize
 *   notifications/initialized
 *   tools/list
 *   tools/call
 *   resources/list
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { apiTokens, users, oauthAccessTokens } from "../db/schema";
import type { User } from "../db/schema";
import { sha256Hex } from "../lib/oauth";
import {
  MCP_TOOLS,
  MCP_TOOL_MAP,
  McpToolError,
  serializeTool,
} from "../lib/mcp-tools";

const mcp = new Hono();

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "gluecron", version: "1.0.0" };

// JSON-RPC error codes
const E_PARSE = -32700;
const E_INVALID_REQUEST = -32600;
const E_METHOD_NOT_FOUND = -32601;
const E_INVALID_PARAMS = -32602;
const E_INTERNAL = -32603;
const E_UNAUTHORIZED = -32001;
const E_NOT_FOUND = -32004;

// Methods that do NOT require authentication
const PUBLIC_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "tools/list",
  "resources/list",
]);

// --------------------------------------------------------------------------
// Auth helpers (inline — no middleware, raw handler)
// --------------------------------------------------------------------------

async function loadUserFromPat(token: string): Promise<User | null> {
  if (!token.startsWith("glc_")) return null;
  try {
    const hash = await sha256Hex(token);
    const [row] = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hash))
      .limit(1);
    if (!row) return null;
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) return null;
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    if (!user) return null;
    // Best-effort: update lastUsedAt
    db.update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokens.id, row.id))
      .catch(() => {});
    return user;
  } catch {
    return null;
  }
}

async function loadUserFromOauthBearer(token: string): Promise<User | null> {
  if (!token.startsWith("glct_")) return null;
  try {
    const hash = await sha256Hex(token);
    const [row] = await db
      .select()
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.accessTokenHash, hash))
      .limit(1);
    if (!row) return null;
    if (row.revokedAt) return null;
    if (new Date(row.expiresAt) < new Date()) return null;
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    if (!user) return null;
    db.update(oauthAccessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(oauthAccessTokens.id, row.id))
      .catch(() => {});
    return user;
  } catch {
    return null;
  }
}

/**
 * Extract the authenticated user (or null) from the Authorization header.
 * Accepts both PAT (`glc_`) and OAuth bearer (`glct_`) tokens.
 */
async function resolveUser(authHeader: string | undefined): Promise<User | null> {
  if (!authHeader) return null;
  const lower = authHeader.toLowerCase();
  if (!lower.startsWith("bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  if (token.startsWith("glct_")) return loadUserFromOauthBearer(token);
  if (token.startsWith("glc_")) return loadUserFromPat(token);
  return null;
}

// --------------------------------------------------------------------------
// JSON-RPC helpers
// --------------------------------------------------------------------------

type JsonRpcId = string | number | null;

function rpcOk(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

// --------------------------------------------------------------------------
// Method handlers
// --------------------------------------------------------------------------

function handleInitialize() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: {},
      resources: { subscribe: false },
    },
    serverInfo: SERVER_INFO,
  };
}

function handleToolsList() {
  return { tools: MCP_TOOLS.map(serializeTool) };
}

function handleResourcesList() {
  return { resources: [] };
}

async function handleToolsCall(
  params: Record<string, unknown>,
  user: User | null
): Promise<unknown> {
  const toolName = params.name as string | undefined;
  if (!toolName) {
    throw new McpToolError(E_INVALID_PARAMS, "params.name is required for tools/call");
  }

  const tool = MCP_TOOL_MAP.get(toolName);
  if (!tool) {
    throw new McpToolError(E_NOT_FOUND, `Unknown tool: '${toolName}'`);
  }

  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const result = await tool.handler(args, user);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

// --------------------------------------------------------------------------
// POST /mcp — main JSON-RPC dispatcher
// --------------------------------------------------------------------------

mcp.post("/mcp", async (c) => {
  // Resolve authenticated user (may be null for public requests)
  const authHeader = c.req.header("authorization");
  const user = await resolveUser(authHeader);

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json(rpcError(null, E_PARSE, "Parse error: invalid JSON"), 200);
  }

  // Validate JSON-RPC envelope
  if (body.jsonrpc !== "2.0" || !body.method) {
    return c.json(
      rpcError(body.id as JsonRpcId ?? null, E_INVALID_REQUEST, "Invalid JSON-RPC request"),
      200
    );
  }

  const id = (body.id as JsonRpcId) ?? null;
  const method = body.method as string;
  const params = (body.params ?? {}) as Record<string, unknown>;

  // Auth gate: tools/call that mutate or read private data require auth
  // (public methods are allowed without a token)
  if (!PUBLIC_METHODS.has(method) && method !== "tools/call") {
    // Any unknown method — we'll return method-not-found below, not an auth error
  }

  // For tools/call: auth is enforced at the tool level (each tool decides)
  // but we still need a user object passed through.

  try {
    let result: unknown;

    switch (method) {
      case "initialize":
        result = handleInitialize();
        break;

      case "notifications/initialized":
        // Client acknowledgement — no-op, return empty result
        result = {};
        break;

      case "tools/list":
        result = handleToolsList();
        break;

      case "tools/call":
        result = await handleToolsCall(params, user);
        break;

      case "resources/list":
        result = handleResourcesList();
        break;

      default:
        return c.json(rpcError(id, E_METHOD_NOT_FOUND, `Method not found: '${method}'`), 200);
    }

    return c.json(rpcOk(id, result), 200);
  } catch (err) {
    if (err instanceof McpToolError) {
      return c.json(rpcError(id, err.code, err.message), 200);
    }
    // Unexpected error
    console.error("[mcp] unhandled error:", err);
    return c.json(rpcError(id, E_INTERNAL, "Internal error"), 200);
  }
});

// --------------------------------------------------------------------------
// GET /mcp — server discovery (no auth required)
// --------------------------------------------------------------------------

mcp.get("/mcp", async (c) => {
  return c.json({
    name: "gluecron",
    version: "1.0.0",
    description: "AI-native code intelligence platform",
    transport: "http",
    endpoint: "/mcp",
    protocolVersion: PROTOCOL_VERSION,
    tools: MCP_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
    })),
  });
});

export default mcp;
