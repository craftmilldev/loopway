import { ApiError, type LoopwayClient } from "../client.js";
import { authedClient, type Context } from "../context.js";
import { dim, json, table } from "../format.js";
import { resolveBot } from "./bots.js";

/** `loopway bots threads <bot>`: the threads the server has for a bot. */
export async function listBotThreads(ctx: Context, ref: string, opts: { status?: string; json?: boolean }) {
  const client = await authedClient(ctx);
  const status = (opts.status ?? "active") as "active" | "ended" | "all";
  const threads = await client.listThreads(await resolveBot(client, ref), status);
  if (opts.json) return ctx.out(json(threads));
  if (!threads.length) return ctx.out(status === "all" ? "No threads." : `No ${status} threads.`);
  const names = new Map((await client.listRunners()).map((r) => [r.id, r.name]));
  ctx.out(
    table(
      ["ID", "STATUS", "SUBJECTS", "RUNNER", "WAITING", "INFLIGHT", "DELIVERED"],
      threads.map((t) => [
        t.id,
        t.status,
        t.subjects.join(", "),
        names.get(t.runner_id ?? "") ?? t.runner_id ?? dim("none"),
        String(t.waiting.length),
        String(t.inflight.length),
        String(t.delivered),
      ]),
    ),
  );
}

/**
 * `loopway bots threads release <bot> <thread>`: the manual move for a thread whose runner is gone. The thread has
 * no owner afterwards, so a runner can claim it.
 */
export async function releaseBotThread(ctx: Context, ref: string, threadId: string) {
  const client = await authedClient(ctx);
  const thread = await client.releaseThread(await resolveBot(client, ref), threadId);
  ctx.out(`Released thread ${thread.id}; a runner can claim it now.`);
}

/**
 * `loopway bots threads end <bot> <thread>`: ends a thread from the terminal, with no lease. Its waiting and inflight
 * messages stay as they are and the runner keeps its claim; the next message for the thread resumes it.
 */
export async function endBotThread(ctx: Context, ref: string, threadId: string, opts: { json?: boolean }) {
  const client = await authedClient(ctx);
  let thread;
  try {
    thread = await client.endThread(await resolveBot(client, ref), threadId);
  } catch (err) {
    const reason = err instanceof ApiError ? err.code : "error";
    void ctx.metrics?.capture("thread_end_failed", { surface: "cli", reason });
    throw err;
  }
  void ctx.metrics?.capture("thread_ended", { surface: "cli" });
  if (opts.json) return ctx.out(json(thread));
  ctx.out(`Thread ${thread.id} is ${thread.status}.`);
}

/**
 * `loopway bots threads move <bot> <subject> <from-thread> <to-thread>`: the repair for a subject on the wrong thread.
 * The threads may be the start of their ids. The subject's waiting messages go with it; a target that ended resumes.
 */
export async function moveBotSubject(ctx: Context, ref: string, subject: string, from: string, to: string) {
  const client = await authedClient(ctx);
  const botId = await resolveBot(client, ref);
  const find = await threadFinder(client, botId);
  const thread = await client.moveSubject(botId, subject, find(from), find(to));
  ctx.out(`Moved ${subject} to thread ${thread.id} (${thread.status}).`);
}

/** Looks a thread of the bot up by the start of its id. */
async function threadFinder(client: LoopwayClient, botId: string) {
  const threads = await client.listThreads(botId, "all");
  return (prefix: string) => {
    const matches = threads.filter((t) => t.id.startsWith(prefix.toLowerCase()));
    if (matches.length !== 1)
      throw new Error(matches.length ? `"${prefix}" matches ${matches.length} threads` : `No thread "${prefix}"`);
    return matches[0]!.id;
  };
}

/**
 * `loopway bots threads send <bot> <thread> <text...>`: sends a message to the thread. It goes through the bot's inbox,
 * so the bot's runner hands it to the thread's session like any other message.
 */
export async function sendBotThreadMessage(ctx: Context, ref: string, thread: string, words: string[]) {
  const client = await authedClient(ctx);
  const botId = await resolveBot(client, ref);
  const threadId = (await threadFinder(client, botId))(thread);
  try {
    await client.sendThreadMessage(botId, threadId, words.join(" "));
  } catch (err) {
    const reason = err instanceof ApiError ? err.code : "error";
    void ctx.metrics?.capture("thread_message_failed", { surface: "cli", reason });
    throw err;
  }
  void ctx.metrics?.capture("thread_message_sent", { surface: "cli" });
  ctx.out(`Sent to thread ${threadId.slice(0, 8)}; its runner will pick it up.`);
}
