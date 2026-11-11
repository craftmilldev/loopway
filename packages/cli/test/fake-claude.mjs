#!/usr/bin/env node
// Stands in for `claude -p` in tests: reads the message on stdin, writes stream-json, and does what $FAKE_CLAUDE says.
//   ok          finish without sending anything
//   comment     call loopway's MCP `comment` tool on $FAKE_SUBJECT, then finish
//   ask         call loopway's MCP `ask` tool on $FAKE_SUBJECT with a question, then finish
//   permission  ask loopway's MCP `permission` tool whether Bash may run $FAKE_COMMAND, then finish
//   api         end on an API error
//   limit       end on the usage limit, resetting at $FAKE_RESETS (epoch seconds)
//   die         exit 1 in the middle of the run
// $FAKE_RECORD is a file it appends one JSON line to: the arguments and the message.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
let message = "";
for await (const chunk of process.stdin) message += chunk;
if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ args, message }) + "\n");

const out = (record) => console.log(JSON.stringify(record));
const flag = (name) => args[args.indexOf(name) + 1];
const sessionId = flag("--session-id") ?? flag("--resume");
const mode = process.env.FAKE_CLAUDE ?? "ok";

out({ type: "system", subtype: "init", session_id: sessionId });
out({ type: "assistant", message: { content: [{ type: "text", text: "On it." }] } });

if (mode === "die") process.exit(1);

/** Calls one of loopway's MCP tools the way Claude Code does, and logs the call and what came back. */
async function callTool(name, input) {
  const { url } = JSON.parse(flag("--mcp-config")).mcpServers.loopway;
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: input } };
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: `mcp__loopway__${name}`, input }] } });
  const res = await fetch(url, { method: "POST", body: JSON.stringify(call) });
  const { result } = await res.json();
  out({
    type: "user",
    message: { content: [{ type: "tool_result", content: [{ type: "text", text: result.content[0].text }] }] },
  });
}

if (mode === "comment") await callTool("comment", { subject: process.env.FAKE_SUBJECT, body: "4" });
if (mode === "ask") await callTool("ask", { subject: process.env.FAKE_SUBJECT, question: "Which file name?" });
if (mode === "permission") {
  const input = { command: process.env.FAKE_COMMAND };
  await callTool("permission", { tool_name: "Bash", input, tool_use_id: "toolu_1" });
}

if (mode === "limit") {
  out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Number(process.env.FAKE_RESETS) } });
  out({ type: "result", subtype: "success", is_error: true, api_error: "usage_limit_reached", result: "limit" });
} else if (mode === "api") {
  out({ type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded" });
} else {
  out({ type: "result", subtype: "success", result: "done" });
}
