import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A minimal MCP server (streamable HTTP, JSON responses only) on 127.0.0.1, so `loopway bots run` can
 * give each agent session tools that talk straight back to the dispatcher. Each session gets its
 * own URL (`/<secret>/<session>`); the random secret keeps other local processes from guessing one.
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Returns the text the agent sees; a thrown Error comes back as a tool error. */
  call: (sessionId: string, args: Record<string, unknown>) => Promise<string>;
}

export interface McpServer {
  urlFor: (sessionId: string) => string;
  close: () => Promise<void>;
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export async function startMcpServer(name: string, tools: McpTool[]): Promise<McpServer> {
  const secret = randomBytes(16).toString("hex");

  const handle = async (sessionId: string, req: RpcRequest): Promise<unknown> => {
    switch (req.method) {
      case "initialize":
        return {
          protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name, version: "0.1.0" },
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      case "tools/call": {
        const tool = tools.find((t) => t.name === req.params?.name);
        if (!tool) throw new RpcError(-32602, `Unknown tool ${String(req.params?.name)}`);
        try {
          const text = await tool.call(sessionId, (req.params?.arguments ?? {}) as Record<string, unknown>);
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      }
      default:
        throw new RpcError(-32601, `Method not found: ${req.method}`);
    }
  };

  // Answers its own errors (bad JSON, failed tool calls), so createServer doesn't need the promise.
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const [, key, sessionId] = (req.url ?? "").split("/");
    if (key !== secret || !sessionId) return void res.writeHead(404).end();
    // No server-initiated messages, so there's no SSE stream to open.
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();

    let msg: RpcRequest;
    try {
      msg = JSON.parse(await readBody(req)) as RpcRequest;
    } catch {
      return void res.writeHead(400).end();
    }
    if (msg.id === undefined) return void res.writeHead(202).end(); // a notification

    let reply: Record<string, unknown>;
    try {
      reply = { jsonrpc: "2.0", id: msg.id, result: await handle(sessionId, msg) };
    } catch (err) {
      const { code, message } = err instanceof RpcError ? err : { code: -32603, message: String(err) };
      reply = { jsonrpc: "2.0", id: msg.id, error: { code, message } };
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  };
  const server = createServer((req, res) => void serve(req, res));

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    urlFor: (sessionId) => `http://127.0.0.1:${port}/${secret}/${sessionId}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
