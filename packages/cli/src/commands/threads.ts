import { setTimeout as sleep } from "node:timers/promises";
import { authedClient, type Context } from "../context.js";
import { DEFAULTS, Dispatcher, type ThreadsOptions } from "../threads/dispatcher.js";
import { BOT_KINDS } from "../threads/kinds.js";
import { showTui } from "../threads/tui.js";

export interface RunBotsOptions extends ThreadsOptions {
  /** false with --no-tui; the TUI only shows in an interactive terminal either way. */
  tui?: boolean;
}

/** `loopway bots run`: run every bot on the account, handing each message to its thread's session, forever. */
export async function runBots(ctx: Context, opts: RunBotsOptions) {
  const client = await authedClient(ctx);
  const all = await client.listBots();
  const bots = all.filter((b) => b.kind in BOT_KINDS);
  for (const b of all)
    if (!(b.kind in BOT_KINDS)) ctx.out(`Skipping bot ${b.name}: this CLI can't run kind ${b.kind}.`);
  if (!bots.length) {
    ctx.out(
      `No bots to run. Create one with \`loopway bots create --name <name> --kind ${Object.keys(BOT_KINDS).join("|")} --inbox <inbox>\`.`,
    );
    return;
  }
  const interval = opts.interval ?? DEFAULTS.interval;
  const names = bots.map((b) => b.name).join(", ");
  const watching = `Running ${names} every ${interval}s (at most ${opts.max ?? DEFAULTS.max} sessions running at once).`;

  if (opts.tui === false || !ctx.interactive) {
    const dispatcher = await Dispatcher.start(ctx, client, bots, opts);
    releaseOnInterrupt(dispatcher);
    ctx.out(`${watching} Ctrl-C to stop.`);
    return pollForever(ctx, dispatcher, interval);
  }

  // The dispatcher's log lines go to the TUI's status line instead of scrolling under it.
  let message = watching;
  const quiet: Context = { ...ctx, out: (t) => void (message = t) };
  const dispatcher = await Dispatcher.start(quiet, client, bots, opts);
  releaseOnInterrupt(dispatcher);
  void pollForever(quiet, dispatcher, interval);
  await showTui({
    load: async () => ({ ...(await dispatcher.state()), message }),
    readLog: (id) => dispatcher.readLog(id),
  });
  // Quitting stops everything, as Ctrl-C does without the TUI: interrupt the whole process group so
  // the claude sessions this dispatcher started stop with it.
  process.kill(0, "SIGINT");
}

/** On Ctrl-C, gives the bot leases back before exiting, so the next runner doesn't wait out the TTL. */
function releaseOnInterrupt(dispatcher: Dispatcher) {
  process.once("SIGINT", () => void dispatcher.close().finally(() => process.exit(130)));
}

async function pollForever(ctx: Context, dispatcher: Dispatcher, interval: number): Promise<never> {
  for (;;) {
    try {
      await dispatcher.tick();
    } catch (err) {
      // A flaky network shouldn't take down running sessions; try again next tick.
      ctx.out(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Poll again after the interval, or as soon as a run exits so its slot goes to a waiting session.
    const timer = new AbortController();
    await Promise.race([
      sleep(interval * 1000, undefined, { signal: timer.signal }).catch(() => {}),
      dispatcher.slotFreed(),
    ]);
    timer.abort();
  }
}
