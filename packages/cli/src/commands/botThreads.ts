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
