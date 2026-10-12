import { setTimeout as sleep } from "node:timers/promises";
import { authedClient, type Context } from "../context.js";
import { DEFAULTS, Dispatcher, type ThreadsOptions } from "../bots/dispatcher.js";
import { PRESETS, preset } from "@loopway/rules";
import { ensureRunner } from "../bots/runner.js";
import { showTui } from "../bots/tui.js";

export interface RunBotsOptions extends ThreadsOptions {
  /** false with --no-tui; the TUI only shows in an interactive terminal either way. */
  tui?: boolean;
}

/** `loopway bots run`: run every bot on the account, handing each message to its thread's session, forever. */
export async function runBots(ctx: Context, opts: RunBotsOptions) {
  const client = await authedClient(ctx);
  const all = await client.listBots();
  const bots = all.filter((b) => preset(b.kind));
  for (const b of all) if (!preset(b.kind)) ctx.out(`Skipping bot ${b.name}: this CLI can't run kind ${b.kind}.`);
  if (!bots.length) {
    ctx.out(
      `No bots to run. Create one with \`loopway bots create --name <name> --kind ${PRESETS.map((p) => p.id).join("|")} --inbox <inbox>\`.`,
    );
    return;
  }
  // Bots made before prompts or rules were stored get their kind's as a new version, keeping the prompt they have.
  for (const b of bots)
    if (!b.prompt_version?.rules) {
      const kind = preset(b.kind)!;
      b.prompt_version = await client.addBotVersion(b.id, b.prompt_version?.prompt ?? kind.prompt, kind.rules);
    }
  const interval = opts.interval ?? DEFAULTS.interval;
  const runner = await ensureRunner(ctx.configDir, client);
  const dispatcherOpts = { ...opts, ttl: opts.ttl ?? defaultTtl(interval), runnerId: runner.id };
  const names = bots.map((b) => b.name).join(", ");
  const watching = `Running ${names} every ${interval}s (at most ${opts.max ?? DEFAULTS.max} sessions running at once).`;

  if (opts.tui === false || !ctx.interactive) {
    const dispatcher = await Dispatcher.start(ctx, client, bots, dispatcherOpts);
    const release = releaseOnExit(dispatcher);
    ctx.out(`${watching} Ctrl-C to stop.`);
    try {
      return await pollForever(ctx, dispatcher, interval);
    } finally {
      await release();
    }
  }

  // The dispatcher's log lines go to the TUI's status line instead of scrolling under it.
  let message = watching;
  const quiet: Context = { ...ctx, out: (t) => void (message = t) };
  const dispatcher = await Dispatcher.start(quiet, client, bots, dispatcherOpts);
  const release = releaseOnExit(dispatcher);
  void pollForever(quiet, dispatcher, interval);
  try {
    await showTui({
      load: async () => ({ ...(await dispatcher.state()), message }),
      readLog: (id) => dispatcher.readLog(id),
    });
  } finally {
    await release();
  }
  // Quitting stops everything, as Ctrl-C does without the TUI: interrupt the whole process group so
  // the claude sessions this dispatcher started stop with it.
  process.kill(0, "SIGINT");
}

/**
 * The lease TTL when --ttl isn't given. The lease is renewed every poll, so it lasts several polls: one
 * slow renewal mustn't lose it. The floor keeps a tiny --interval from making it fragile.
 */
export const defaultTtl = (interval: number) => Math.max(DEFAULTS.ttl, 6 * interval);

/** How long an exit waits for the leases to be released before going ahead without. */
const RELEASE_TIMEOUT_MS = 5000;

/**
 * Gives the bot leases back however the process ends (Ctrl-C, a SIGTERM or SIGHUP from `kill`, a closed
 * terminal or a supervisor, a crash), so the next runner doesn't wait out the TTL. Returns the release
 * itself, for the exit paths that return: it runs once however often it's called, so a second Ctrl-C
 * joins the first instead of skipping it, and gives up after a few seconds so a lost network can't
 * hang the exit.
 */
function releaseOnExit(dispatcher: Dispatcher): () => Promise<void> {
  let releasing: Promise<void> | undefined;
  const release = () =>
    (releasing ??= Promise.race([
      dispatcher.close().catch(() => {}),
      sleep(RELEASE_TIMEOUT_MS, undefined, { ref: false }),
    ]));
  const exitWith = (code: number) => void release().finally(() => process.exit(code));
  process.on("SIGINT", () => exitWith(130));
  process.on("SIGTERM", () => exitWith(143));
  process.on("SIGHUP", () => exitWith(129));
  const crash = (err: unknown) => (console.error(err), exitWith(1));
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  return release;
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
