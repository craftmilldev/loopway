import { ApiError, type Thread, type ThreadPatch } from "../client.js";
import type { McpTool } from "../mcp.js";
import { noopMetrics, type Metrics } from "../metrics.js";

/** What the tools do to a session's thread: the dispatcher answers with its runner's lease token. */
export interface ThreadApi {
  get(threadId: string): Promise<Thread>;
  patch(threadId: string, patch: ThreadPatch): Promise<Thread>;
}

/** The MCP tools each session gets for talking back to the dispatcher. */
export function sessionTools(api: ThreadApi, metrics: Metrics = noopMetrics): McpTool[] {
  return [
    {
      name: "link",
      description:
        "Have this thread track one more subject, so its events come to this session. Pass `subject`, any subject string the bot's rules produce (`owner/repo#9`, `linear/CRA-41`): a rule that yields it for a message routes that message to this thread. Or pass `number` (and optionally `repo`) for the issue or PR `owner/repo#number`. Exactly one of `subject` or `number` is required. A subject another thread already holds can't be linked.",
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "string", description: "the subject to track, as is, up to 500 characters" },
          number: { type: "integer", description: "the issue or PR number, instead of subject" },
          repo: { type: "string", description: "owner/repo for number; defaults to this thread's repo" },
        },
      },
      call: async (sessionId, args) => {
        const reject = async (reason: string, message: string): Promise<never> => {
          await metrics.capture("link_rejected", { reason });
          throw new Error(message);
        };
        const hasSubject = args.subject !== undefined;
        const hasNumber = args.number !== undefined;
        if (hasSubject === hasNumber) return reject("subject_or_number", "Pass exactly one of subject or number.");
        let key: string;
        if (hasSubject) {
          const s = args.subject;
          if (typeof s !== "string" || !s) return reject("empty_subject", "subject must be a non-empty string.");
          if (s.length > 500) return reject("subject_too_long", "subject must be at most 500 characters.");
          key = s;
        } else {
          const n = args.number;
          if (typeof n !== "number" || !Number.isInteger(n) || n < 1)
            return reject("invalid_number", "number must be a positive integer.");
          const repo =
            typeof args.repo === "string" ? args.repo : (await api.get(sessionId)).subjects[0]?.split("#")[0];
          if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return reject("invalid_repo", "Pass repo as owner/repo.");
          key = `${repo}#${n}`;
        }
        try {
          await api.patch(sessionId, { add_subjects: [key] });
        } catch (err) {
          if (err instanceof ApiError && err.code === "subject_taken") {
            await metrics.capture("link_rejected", { reason: "subject_taken" });
            throw new Error(`Subject ${key} already belongs to another thread, so it can't be linked.`, { cause: err });
          }
          await metrics.capture("link_rejected", { reason: "error" });
          throw err;
        }
        await metrics.capture("link_added", { kind: hasSubject ? "subject" : "number" });
        return `Linked ${key}; its events will come to this session.`;
      },
    },
    {
      name: "record",
      description:
        'Record one fact about your own session on this thread, as a key and a JSON value (for example key `label`, value `"generic"`). This is for your own metadata about yourself, kept by the server; it is not shown to anyone in the thread. Setting a key again replaces its value; other keys stay.',
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "the key, 1 to 200 characters" },
          value: { description: "any JSON value" },
        },
        required: ["key", "value"],
      },
      call: async (sessionId, args) => {
        const key = args.key;
        if (typeof key !== "string" || !key || key.length > 200) {
          await metrics.capture("record_rejected", { reason: "invalid_key" });
          throw new Error("key must be a string of 1 to 200 characters.");
        }
        if (args.value === undefined) {
          await metrics.capture("record_rejected", { reason: "missing_value" });
          throw new Error("Pass a value (any JSON, null included).");
        }
        try {
          await api.patch(sessionId, { metadata_set: { [key]: args.value } });
        } catch (err) {
          await metrics.capture("record_rejected", { reason: err instanceof ApiError ? err.code : "error" });
          throw err;
        }
        await metrics.capture("record_set", {});
        return `Recorded ${key}.`;
      },
    },
    {
      name: "unrecord",
      description: "Remove one key you recorded with `record` from this thread's metadata. Other keys stay.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string", description: "the key to remove" } },
        required: ["key"],
      },
      call: async (sessionId, args) => {
        const key = args.key;
        if (typeof key !== "string" || !key || key.length > 200) {
          await metrics.capture("record_rejected", { reason: "invalid_key" });
          throw new Error("key must be a string of 1 to 200 characters.");
        }
        try {
          await api.patch(sessionId, { metadata_unset: [key] });
        } catch (err) {
          await metrics.capture("record_rejected", { reason: err instanceof ApiError ? err.code : "error" });
          throw err;
        }
        await metrics.capture("record_unset", {});
        return `Removed ${key}.`;
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
