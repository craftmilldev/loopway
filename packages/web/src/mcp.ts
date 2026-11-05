import { ZodError } from "zod";
import { ApiError } from "./http.js";

/**
 * A minimal stateless MCP server over Streamable HTTP: each POST is one JSON-RPC message and gets a JSON answer, with no
 * sessions and no server-to-client stream. That's all push and pull need, and it runs in a serverless function.
 * Who's calling is the bearer token on the request, so the route has already authenticated them.
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Returns the text the agent sees. A thrown ApiError or ZodError is a tool error the agent can act on. */
  call: (args: unknown) => Promise<string>;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

function toolError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof ZodError) return err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  throw err;
}

/** The answer to one JSON-RPC message, or null for a notification, which gets none. */
export async function handleMcp(body: string, tools: McpTool[]): Promise<unknown> {
  let req: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
  try {
    req = JSON.parse(body) as typeof req;
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (!req || typeof req !== "object" || Array.isArray(req) || typeof req.method !== "string") {
    return rpcError(null, -32600, "Invalid request");
  }
  if (req.id === undefined) return null;
  const answer = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });

  switch (req.method) {
    case "initialize": {
      const asked = req.params?.protocolVersion;
      return answer({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked as string) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "loopway", version: "1.0.0" },
      });
    }
    case "ping":
      return answer({});
    case "tools/list":
      return answer({
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const tool = tools.find((t) => t.name === req.params?.name);
      if (!tool) return rpcError(req.id, -32602, `Unknown tool ${String(req.params?.name)}`);
      try {
        return answer({ content: [{ type: "text", text: await tool.call(req.params?.arguments ?? {}) }] });
      } catch (err) {
        return answer({ content: [{ type: "text", text: toolError(err) }], isError: true });
      }
    }
    default:
      return rpcError(req.id, -32601, `Method not found: ${req.method}`);
  }
}
