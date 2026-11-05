# MCP

A hosted MCP server at `/api/mcp` gives agents `push_message` and `pull_messages`. It's stateless: each POST is one JSON-RPC message, and pull takes its cursor as arguments.

## Sub-features

- `initialize` and `tools/list` describe the server.
- `push_message` stores a message.
- `pull_messages` reads from a cursor.
- `auth` refuses a call with no bearer token.

## How to get to it (user POV)

Add the server to an MCP client, with a token from `loopway token create` as its bearer token.

## Driving it with curl

Preconditions: `T` from `tokens.md`, not revoked. Define:

`mcp() { curl -s -X POST "$URL/api/mcp" -H "authorization: Bearer $T" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$1"; echo; }`

- **Initialize.** Run `mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"1"}}}'`. `serverInfo.name` is `loopway`.
- **Tools.** Run `mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'`. `push_message` and `pull_messages`.
- **Push.** Run `mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"push_message","arguments":{"type":"from.mcp","id":"m-1"}}}'`. The text has `"duplicate":false`.
- **Pull.** Run `sleep 6`, then `mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"pull_messages","arguments":{"limit":100}}}'`. The text has `from.mcp`, `next_since` and `has_more`.
- **Auth.** Run `curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/api/mcp" -d '{}'`. `401`.

## Gotchas

- Pull has the same hold-back as a read, and with no `since` starts at the oldest message held.
- This drives the protocol by hand. A real MCP client isn't covered.
