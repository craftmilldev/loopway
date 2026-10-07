import type { McpTool } from "../mcp.js";
import { editSession, withSessions } from "./store.js";

/** The MCP tools each session gets for talking back to the dispatcher. */
export function sessionTools(dir: string): McpTool[] {
  return [
    {
      name: "link",
      description:
        "Send an issue or PR's events to this session. Call it right after you open a PR, with the PR number, so reviews and comments on it come to you.",
      inputSchema: {
        type: "object",
        properties: {
          number: { type: "integer", description: "the issue or PR number" },
          repo: { type: "string", description: "owner/repo; defaults to this thread's repo" },
        },
        required: ["number"],
      },
      call: async (sessionId, args) => {
        const n = args.number;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1)
          throw new Error("number must be a positive integer.");
        return withSessions(dir, (sessions) => {
          const s = editSession(sessions, sessionId);
          const repo = typeof args.repo === "string" ? args.repo : s.keys[0]?.split("#")[0];
          if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Pass repo as owner/repo.");
          const key = `${repo}#${n}`;
          if (!s.keys.includes(key)) s.keys.push(key);
          return `Linked ${key}; its events will come to this session.`;
        });
      },
    },
    {
      name: "end",
      description:
        "Tell the dispatcher this thread's work is finished (the PR is merged or closed for good, or the user asked you to stop). It frees this session's slot once your turn ends. A later event for the thread resumes you and makes it active again.",
      inputSchema: { type: "object", properties: {} },
      call: (sessionId) =>
        withSessions(dir, (sessions) => {
          editSession(sessions, sessionId).status = "ended";
          return "Ended. Your slot frees up when this turn finishes.";
        }),
    },
  ];
}
