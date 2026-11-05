import { describe, expect, it } from "vitest";
import { ageMessages, app, call, newSource, newUser, prPayload, sendGithub } from "./helpers.js";

const rpc = async (key: string | undefined, body: unknown) => {
  const res = await app.request("/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, never>) : null };
};
const tool = async (key: string, name: string, args: unknown) => {
  const { body } = await rpc(key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const result = (body as unknown as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { text: result.content[0]!.text, isError: !!result.isError };
};

describe("the hosted MCP endpoint", () => {
  it("needs a token, and takes an API token or a session", async () => {
    expect((await rpc(undefined, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    const key = await newUser();
    expect((await rpc(key, { jsonrpc: "2.0", id: 1, method: "ping" })).body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
    const { token } = (await call("POST", "/tokens", { key, body: { name: "mcp" } })).body;
    expect((await rpc(token, { jsonrpc: "2.0", id: 2, method: "ping" })).status).toBe(200);
  });

  it("initializes, answering the client's protocol version when it knows it", async () => {
    const key = await newUser();
    const init = async (protocolVersion: string) =>
      (await rpc(key, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } })).body;
    expect(await init("2025-03-26")).toMatchObject({
      result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "loopway" } },
    });
    expect(await init("1999-01-01")).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
  });

  it("accepts notifications without answering, and has no stream or sessions", async () => {
    const key = await newUser();
    const note = await rpc(key, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note).toEqual({ status: 202, body: null });
    const get = await app.request("/api/mcp", { headers: { authorization: `Bearer ${key}` } });
    expect(get.status).toBe(405);
  });

  it("lists its tools", async () => {
    const key = await newUser();
    const { body } = await rpc(key, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const { tools } = (body as unknown as { result: { tools: { name: string; inputSchema: object }[] } }).result;
    expect(tools.map((t) => t.name)).toEqual(["push_message", "pull_messages"]);
    for (const t of tools) expect(t.inputSchema).toMatchObject({ type: "object" });
  });

  it("pushes and pulls the same messages as the API", async () => {
    const key = await newUser();
    const a = await newSource(key);
    await sendGithub(a, "pull_request", prPayload(1));
    const pushed = await tool(key, "push_message", { type: "note", data: { n: 1 } });
    expect(pushed.isError).toBe(false);
    expect(JSON.parse(pushed.text)).toMatchObject({ duplicate: false });
    await ageMessages();
    const pulled = JSON.parse((await tool(key, "pull_messages", { since: "0", limit: 1 })).text);
    expect(pulled.data[0].event.type).toBe("com.github.pull_request.opened");
    expect(pulled.has_more).toBe(true);
    const rest = JSON.parse(
      (await tool(key, "pull_messages", { since: pulled.next_since, after: pulled.next_after })).text,
    );
    expect(rest.data.map((m: { event: { type: string } }) => m.event.type)).toEqual(["note"]);
  });

  it("only ever reads its caller's inbox", async () => {
    const a = await newUser("a");
    const b = await newUser("b");
    await tool(a, "push_message", { type: "private" });
    await ageMessages();
    expect(JSON.parse((await tool(b, "pull_messages", { since: "0" })).text).data).toEqual([]);
  });

  it("makes bad input a tool error the agent can read, and bad protocol a JSON-RPC one", async () => {
    const key = await newUser();
    expect(await tool(key, "push_message", {})).toMatchObject({ isError: true, text: expect.stringContaining("type") });
    expect(await tool(key, "pull_messages", { since: "soon" })).toMatchObject({ isError: true });
    expect((await tool(key, "push_message", { type: "t", data: "a\u0000" })).isError).toBe(false);
    const odd = await rpc(key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: { toString: 1 } } });
    expect(odd.status).toBe(200);
    const code = async (body: unknown) =>
      ((await rpc(key, body)).body as { error?: { code: number } } | null)?.error?.code;
    expect(await code("{nope")).toBe(-32700);
    expect(await code([{ jsonrpc: "2.0", id: 1, method: "ping" }])).toBe(-32600);
    expect(await code({ jsonrpc: "2.0", id: 1, method: "resources/list" })).toBe(-32601);
    expect(await code({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } })).toBe(-32602);
  });
});
