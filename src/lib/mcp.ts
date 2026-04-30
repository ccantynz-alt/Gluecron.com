/**
 * Model Context Protocol (MCP) server — minimal JSON-RPC 2.0 router.
 *
 * MCP: https://spec.modelcontextprotocol.io/
 *
 * v1 scope (this file):
 *   - Streamable HTTP transport at POST /mcp
 *   - initialize / initialized handshake
 *   - tools/list (static manifest)
 *   - tools/call dispatching to a small set of read-only tools
 *
 * Out of scope for v1 (future moves):
 *   - resources/list + resources/read (the bible files, repo READMEs)
 *   - prompts/* (saved-replies as MCP prompts)
 *   - server-sent notifications (logs streaming)
 *   - oauth flow + per-call auth (we accept PAT + OAuth bearer for now)
 *
 * Pure JSON-RPC routing here — the per-tool handlers live in
 * `mcp-tools.ts`. This split lets the router be tested without DB.
 */

import type { McpToolHandler, McpTool } from "./mcp-tools";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_NAME = "gluecron";
export const MCP_SERVER_VERSION = "1.0";

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      result: unknown;
    }
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      error: { code: number; message: string; data?: unknown };
    };

// JSON-RPC standard error codes
export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;

export type McpContext = {
  /** Authenticated user id; null for anonymous (only allowed for some calls). */
  userId: string | null;
};

export type McpRouterArgs = {
  ctx: McpContext;
  tools: Record<string, McpToolHandler>;
};

function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  return (
    !!v &&
    typeof v === "object" &&
    (v as JsonRpcRequest).jsonrpc === "2.0" &&
    typeof (v as JsonRpcRequest).method === "string"
  );
}

/**
 * Route a single JSON-RPC request. Returns the response shape (or null
 * for notifications, which have no `id`). Never throws — internal
 * exceptions are caught and re-shaped as `-32603 internal error`.
 */
export async function routeMcpRequest(
  req: unknown,
  args: McpRouterArgs
): Promise<JsonRpcResponse | null> {
  if (!isJsonRpcRequest(req)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: ERR_INVALID_REQUEST, message: "Invalid JSON-RPC request" },
    };
  }

  const id = req.id ?? null;
  const isNotification = req.id === undefined;

  try {
    const result = await dispatch(req.method, req.params, args);
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, result };
  } catch (err) {
    if (isNotification) return null;
    if (err instanceof McpError) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: err.code, message: err.message, data: err.data },
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: ERR_INTERNAL,
        message: err instanceof Error ? err.message : "internal error",
      },
    };
  }
}

export class McpError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

async function dispatch(
  method: string,
  params: unknown,
  args: McpRouterArgs
): Promise<unknown> {
  switch (method) {
    case "initialize":
      return handleInitialize();
    case "notifications/initialized":
      // Client → server notification, no response.
      return null;
    case "tools/list":
      return handleToolsList(args.tools);
    case "tools/call":
      return handleToolsCall(params, args);
    case "ping":
      return {};
    default:
      throw new McpError(
        ERR_METHOD_NOT_FOUND,
        `Method not supported: ${method}`
      );
  }
}

function handleInitialize() {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
  };
}

function handleToolsList(
  tools: Record<string, McpToolHandler>
): { tools: McpTool[] } {
  return {
    tools: Object.values(tools).map((t) => t.tool),
  };
}

async function handleToolsCall(
  params: unknown,
  args: McpRouterArgs
): Promise<unknown> {
  if (!params || typeof params !== "object") {
    throw new McpError(ERR_INVALID_PARAMS, "tools/call requires {name, arguments}");
  }
  const p = params as { name?: unknown; arguments?: unknown };
  const name = typeof p.name === "string" ? p.name : "";
  if (!name) {
    throw new McpError(ERR_INVALID_PARAMS, "tools/call requires `name`");
  }
  const handler = args.tools[name];
  if (!handler) {
    throw new McpError(ERR_METHOD_NOT_FOUND, `Unknown tool: ${name}`);
  }
  const toolArgs =
    p.arguments && typeof p.arguments === "object"
      ? (p.arguments as Record<string, unknown>)
      : {};
  // The MCP tools/call result shape is `{ content: [{type, text}], isError? }`.
  // Tool handlers may either return that shape directly or just a value
  // we wrap. Errors from handlers re-throw as McpError so the wrapper
  // can re-shape them.
  const out = await handler.run(toolArgs, args.ctx);
  if (out && typeof out === "object" && Array.isArray((out as any).content)) {
    return out;
  }
  return {
    content: [
      {
        type: "text",
        text: typeof out === "string" ? out : JSON.stringify(out, null, 2),
      },
    ],
  };
}
