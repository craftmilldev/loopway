import type { Thread, ThreadPatch } from "../client.js";
import type { McpTool } from "../mcp.js";

/** What the tools do to a session's thread: the dispatcher answers with its runner's lease token. */
export interface ThreadApi {
  get(threadId: string): Promise<Thread>;
  patch(threadId: string, patch: ThreadPatch): Promise<Thread>;
  reply(threadId: string, text: string): Promise<unknown>;
}

/** The MCP tools each session gets for talking back to the dispatcher. */
export function sessionTools(api: ThreadApi): McpTool[] {
  return [
    {
      name: "link",
      description:
        "Have this thread track one more subject, so its events come to this session. A subject another thread already holds can't be linked.",
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
        const repo = typeof args.repo === "string" ? args.repo : (await api.get(sessionId)).subjects[0]?.split("#")[0];
        if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Pass repo as owner/repo.");
        const key = `${repo}#${n}`;
        await api.patch(sessionId, { add_subjects: [key] });
        return `Linked ${key}; its events will come to this session.`;
      },
    },
    {
      name: "reply",
      description:
        "Answer the message loopway itself sent this thread, such as one from loopway's setup chat. The text goes back to loopway and nowhere else: it is not a comment on GitHub or Linear and not a message to the user on any other channel, so use those tools' own commands for those.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "the reply, as plain text" } },
        required: ["text"],
      },
      call: async (sessionId, args) => {
        if (typeof args.text !== "string" || !args.text.trim()) throw new Error("text must be a non-empty string.");
        await api.reply(sessionId, args.text);
        return "Replied to loopway.";
      },
    },
    {
      name: "end",
      description:
        "Tell the dispatcher this thread's work is finished (the PR is merged or closed for good, or the user asked you to stop). It moves the thread to done. A later event for the thread resumes you and makes it active again.",
      inputSchema: { type: "object", properties: {} },
      call: async (sessionId) => {
        await api.patch(sessionId, { status: "ended" });
        return "Ended. A later event for this thread resumes you.";
      },
    },
  ];
}
