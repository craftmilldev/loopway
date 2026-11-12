import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { askedMessage, deny, type PermissionResult } from "./asks.js";
import type { Made } from "./source.js";

/** What the session may ask loopway to do. Every message a session sends goes through one of these. */
export interface Tools {
  /** Posts a comment on `subject` (`owner/repo#N`) for thread `threadId`; resolves to the comment's URL. */
  comment(threadId: string, subject: string, body: string): Promise<string>;
  /** Posts `question` on `subject` and blocks thread `threadId` until someone answers; resolves to the comment's URL. */
  ask(threadId: string, subject: string, question: string): Promise<string>;
  /** Decides a call Claude Code would prompt for: the rules, then a reaction from the owner. */
  permission(threadId: string, tool: string, input: unknown): Promise<PermissionResult>;
  /** Opens an issue in `repo` (`owner/name`) for thread `threadId`, and has the thread track it. */
  createIssue(threadId: string, repo: string, title: string, body: string, assign: boolean): Promise<Made>;
  /** Opens a pull request from branch `head` into `base` for thread `threadId`, and has the thread track it. */
  createPr(threadId: string, repo: string, head: string, base: string, title: string, body: string): Promise<Made>;
}

export interface McpServer {
  /** The endpoint to give a thread's session: the thread is the last part of the path. */
  urlFor(threadId: string): string;
  close(): Promise<void>;
}

const COMMENT_TOOL = {
  name: "comment",
  description:
    "Post a comment on a GitHub issue or pull request as loopway-bot. This is how you talk to people: say what you did, " +
    "what you found, or what you need. subject is owner/repo#N.",
  inputSchema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "The issue or pull request, like owner/repo#12." },
      body: { type: "string", description: "The comment, in Markdown." },
    },
    required: ["subject", "body"],
  },
};

const ASK_TOOL = {
  name: "ask",
  description:
    "Ask a person a question on a GitHub issue or pull request, when you need them to decide or you are stuck. After " +
    "you call it, end your turn: you are resumed with their reply. subject is owner/repo#N.",
  inputSchema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "The issue or pull request, like owner/repo#12." },
      question: { type: "string", description: "The question, in Markdown." },
    },
    required: ["subject", "question"],
  },
};

/** Not for the session: Claude Code calls it (`--permission-prompt-tool`) for a call that needs permission. */
const PERMISSION_TOOL = {
  name: "permission",
  description: "Claude Code's permission prompt: decides whether a tool call may go ahead.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

const CREATE_ISSUE_TOOL = {
  name: "create_issue",
  description:
    "Open a GitHub issue as loopway-bot. This is the only way to open one: never use gh for it. The thread then tracks " +
    "the new issue. Set assign to assign it to the person running loopway, which starts a thread to work it; without " +
    "assign the issue is only filed, and nobody starts on it.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "The repository, like owner/name." },
      title: { type: "string", description: "The issue's title." },
      body: { type: "string", description: "The issue's text, in Markdown." },
      assign: {
        type: "boolean",
        description: "Assign the issue to the person running loopway, so work starts on it. Default false.",
      },
    },
    required: ["repo", "title", "body"],
  },
};

const CREATE_PR_TOOL = {
  name: "create_pr",
  description:
    "Open a GitHub pull request as loopway-bot. This is the only way to open one: never use gh for it. Push the branch " +
    "yourself first, with git. The thread then tracks the pull request, and loopway starts a thread to review it.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "The repository, like owner/name." },
      head: { type: "string", description: "The branch you pushed, with the changes." },
      base: { type: "string", description: "The branch to merge into, like main." },
      title: { type: "string", description: "The pull request's title." },
      body: { type: "string", description: "The pull request's text, in Markdown." },
    },
    required: ["repo", "head", "base", "title", "body"],
  },
};

interface Request {
  id?: number | string;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
}

/** A minimal MCP server over HTTP (JSON-RPC, one response per POST) on a local port, for Claude Code's `--mcp-config`. */
export async function startMcp(tools: Tools): Promise<McpServer> {
  const server = createServer((req, res) => void handle(tools, req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    urlFor: (threadId) => `http://127.0.0.1:${port}/mcp/${encodeURIComponent(threadId)}`,
    close: () => closeServer(server),
  };
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

async function handle(tools: Tools, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const threadId = /^\/mcp\/([^/]+)$/.exec(req.url ?? "")?.[1];
  if (req.method !== "POST" || !threadId) return send(res, 404);
  let request: Request;
  try {
    request = JSON.parse(await readBody(req)) as Request;
  } catch {
    return send(res, 400, rpcError(undefined, -32700, "parse error"));
  }
  // Notifications have no id and get no answer.
  if (request.id === undefined) return send(res, 202);
  send(res, 200, await answer(tools, decodeURIComponent(threadId), request));
}

async function answer(tools: Tools, threadId: string, request: Request) {
  const { id, method, params } = request;
  if (method === "initialize") {
    const result = {
      protocolVersion: params?.protocolVersion ?? "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "loopway", version: "2.0.0" },
    };
    return { jsonrpc: "2.0", id, result };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list")
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: [COMMENT_TOOL, ASK_TOOL, CREATE_ISSUE_TOOL, CREATE_PR_TOOL, PERMISSION_TOOL] },
    };
  if (method === "tools/call" && params?.name === "comment")
    return { jsonrpc: "2.0", id, result: await comment(tools, threadId, params.arguments) };
  if (method === "tools/call" && params?.name === "ask")
    return { jsonrpc: "2.0", id, result: await ask(tools, threadId, params.arguments) };
  if (method === "tools/call" && params?.name === "permission")
    return { jsonrpc: "2.0", id, result: await permission(tools, threadId, params.arguments) };
  if (method === "tools/call" && params?.name === "create_issue")
    return { jsonrpc: "2.0", id, result: await createIssue(tools, threadId, params.arguments) };
  if (method === "tools/call" && params?.name === "create_pr")
    return { jsonrpc: "2.0", id, result: await createPr(tools, threadId, params.arguments) };
  return rpcError(id, -32601, `no such method or tool: ${method}`);
}

/** A failed tool call is a result the session can read, not a protocol error. */
async function comment(tools: Tools, threadId: string, args: Record<string, unknown> | undefined) {
  const { subject, body } = args ?? {};
  if (typeof subject !== "string" || typeof body !== "string" || !body.trim()) {
    return text("comment needs a subject (owner/repo#N) and a body", true);
  }
  try {
    return text(`posted ${await tools.comment(threadId, subject, body)}`);
  } catch (err) {
    return text(`could not comment: ${(err as Error).message}`, true);
  }
}

async function ask(tools: Tools, threadId: string, args: Record<string, unknown> | undefined) {
  const { subject, question } = args ?? {};
  if (typeof subject !== "string" || typeof question !== "string" || !question.trim()) {
    return text("ask needs a subject (owner/repo#N) and a question", true);
  }
  try {
    return text(askedMessage(await tools.ask(threadId, subject, question)));
  } catch (err) {
    return text(`could not ask: ${(err as Error).message}`, true);
  }
}

/** Claude Code reads the result as JSON: a call it could not settle is refused, never let through. */
async function permission(tools: Tools, threadId: string, args: Record<string, unknown> | undefined) {
  const toolName = args?.tool_name;
  if (typeof toolName !== "string") return text(JSON.stringify(deny("no tool_name in the permission request")));
  try {
    return text(JSON.stringify(await tools.permission(threadId, toolName, args?.input)));
  } catch (err) {
    return text(JSON.stringify(deny(`loopway could not decide: ${(err as Error).message}`)));
  }
}

async function createIssue(tools: Tools, threadId: string, args: Record<string, unknown> | undefined) {
  const { repo, title, body, assign } = args ?? {};
  if (
    !isText(repo) ||
    !isText(title) ||
    typeof body !== "string" ||
    (assign !== undefined && typeof assign !== "boolean")
  )
    return text(
      "create_issue needs a repo (owner/name), a title, a body and, optionally, assign (true or false)",
      true,
    );
  try {
    return text(created(await tools.createIssue(threadId, repo, title, body, assign === true)));
  } catch (err) {
    return text(`could not create the issue: ${(err as Error).message}`, true);
  }
}

async function createPr(tools: Tools, threadId: string, args: Record<string, unknown> | undefined) {
  const { repo, head, base, title, body } = args ?? {};
  if (!isText(repo) || !isText(head) || !isText(base) || !isText(title) || typeof body !== "string")
    return text("create_pr needs a repo (owner/name), a head branch, a base branch, a title and a body", true);
  try {
    return text(created(await tools.createPr(threadId, repo, head, base, title, body)));
  } catch (err) {
    return text(`could not create the pull request: ${(err as Error).message}`, true);
  }
}

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const created = ({ subject, url }: Made) => `created ${subject.key}: ${url}`;

const text = (message: string, isError = false) => ({ content: [{ type: "text", text: message }], isError });

const rpcError = (id: Request["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

function send(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
