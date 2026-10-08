import { setTimeout as sleep } from "node:timers/promises";
import { authedClient, type Context } from "../context.js";
import { DEFAULTS, Dispatcher, type ThreadsOptions } from "../threads/dispatcher.js";
import { showTui } from "../threads/tui.js";
import { resolveInbox } from "./inboxes.js";

export interface RunThreadsOptions extends ThreadsOptions {
  /** false with --no-tui; the TUI only shows in an interactive terminal either way. */
  tui?: boolean;
}

/** `loopway threads <inbox>`: poll forever, handing each pending event to its thread's session. */
export async function runThreads(ctx: Context, inboxRef: string, opts: RunThreadsOptions) {
  const client = await authedClient(ctx);
  const inboxId = await resolveInbox(client, inboxRef);
  const interval = opts.interval ?? DEFAULTS.interval;
  const watching = `Watching ${inboxRef} every ${interval}s (at most ${opts.max ?? DEFAULTS.max} sessions running at once).`;

  if (opts.tui === false || !ctx.interactive) {
    const dispatcher = await Dispatcher.start(ctx, client, inboxId, opts);
    ctx.out(`${watching} Ctrl-C to stop.`);
    return pollForever(ctx, dispatcher, interval);
  }

  // The dispatcher's log lines go to the TUI's status line instead of scrolling under it.
  let message = watching;
  const quiet: Context = { ...ctx, out: (t) => void (message = t) };
  const dispatcher = await Dispatcher.start(quiet, client, inboxId, opts);
  void pollForever(quiet, dispatcher, interval);
  await showTui({
    inbox: inboxRef,
    load: async () => ({ ...(await dispatcher.state()), message }),
    readLog: (id) => dispatcher.readLog(id),
  });
  // Quitting stops everything, as Ctrl-C does without the TUI: interrupt the whole process group so
  // the claude sessions this dispatcher started stop with it.
  process.kill(0, "SIGINT");
}

async function pollForever(ctx: Context, dispatcher: Dispatcher, interval: number): Promise<never> {
  for (;;) {
    try {
      await dispatcher.tick();
    } catch (err) {
      // A flaky network shouldn't take down running sessions; try again next tick.
      ctx.out(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Poll again after the interval, or as soon as a run exits so its slot goes to a waiting event.
    const timer = new AbortController();
    await Promise.race([
      sleep(interval * 1000, undefined, { signal: timer.signal }).catch(() => {}),
      dispatcher.slotFreed(),
    ]);
    timer.abort();
  }
}
