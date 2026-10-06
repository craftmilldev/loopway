import { setTimeout as sleep } from "node:timers/promises";
import { authedClient, type Context } from "../context.js";
import { DEFAULTS, Dispatcher, type ThreadsOptions } from "../threads/dispatcher.js";
import { resolveInbox } from "./inboxes.js";

/** `loopway threads <inbox>`: poll forever, handing each pending event to its thread's session. */
export async function runThreads(ctx: Context, inboxRef: string, opts: ThreadsOptions) {
  const client = await authedClient(ctx);
  const inboxId = await resolveInbox(client, inboxRef);
  const interval = opts.interval ?? DEFAULTS.interval;
  const dispatcher = await Dispatcher.start(ctx, client, inboxId, opts);
  ctx.out(`Watching ${inboxRef} every ${interval}s (at most ${opts.max ?? DEFAULTS.max} sessions). Ctrl-C to stop.`);
  for (;;) {
    try {
      await dispatcher.tick();
    } catch (err) {
      // A flaky network shouldn't take down running sessions; try again next tick.
      ctx.out(`error: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(interval * 1000);
  }
}
