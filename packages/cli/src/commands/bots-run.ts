import { setTimeout as sleep } from "node:timers/promises";
import { ApiError, type LoopwayClient } from "../client.js";
import { sandboxProblem } from "@loopway/harnesses";
import { applyUpdate, availableUpdate as availableUpdateNow } from "../update.js";
import { authedClient, UsageError, type Context } from "../context.js";
import { DEFAULTS, Dispatcher, type ThreadsOptions } from "../bots/dispatcher.js";
import { ensureRunner, savedRunnerOrg } from "../bots/runner.js";
import { resolveOrg } from "./orgs.js";
import { showTui } from "../bots/tui.js";
import { CLI_VERSION } from "../version.js";

export interface RunBotsOptions extends ThreadsOptions {
  /** The slug of the org to run bots for; remembered with the runner. */
  org?: string;
  /** false with --no-tui; the TUI only shows in an interactive terminal either way. */
  tui?: boolean;
}

/** `loopway bots run`: run every bot of one org, handing each message to its thread's session, forever. */
export async function runBots(ctx: Context, opts: RunBotsOptions) {
  const client = await authedClient(ctx);
  const runner = await ensureRunner(ctx, client, await runnerOrg(ctx, client, opts.org));
  const all = (await client.listBots()).filter((b) => b.org_id === runner.org_id);
  const bots = all.filter((b) => b.prompt_version?.rules);
  for (const b of all)
    if (!b.prompt_version?.rules) {
      ctx.out(`Skipping bot ${b.name}: it has no prompt and rules yet. Set them with \`loopway bots edit\`.`);
      void ctx.metrics?.capture("bot_skipped", { reason: "no_version" });
    }
  if (!bots.length) {
    ctx.out(
      `No bots to run. Create one with \`loopway bots create --name <name> --preset <preset> --model <model> --inbox <inbox>\`.`,
    );
    return;
  }
  // Claude bots only run sandboxed, so refuse up front rather than failing every run.
  const problem = bots.some((b) => b.harness === "claude") ? sandboxProblem() : undefined;
  if (problem) {
    void ctx.metrics?.capture("bots_run_refused", { reason: problem.reason, platform: process.platform });
    throw new UsageError(problem.message);
  }
  const interval = opts.interval ?? DEFAULTS.interval;
  const dispatcherOpts = {
    ...opts,
    ttl: opts.ttl ?? defaultTtl(interval),
    runnerId: runner.id,
    seen: all.map((b) => b.id),
  };
  const names = bots.map((b) => b.name).join(", ");
  const watching = `loopway ${CLI_VERSION}: running ${names} every ${interval}s (at most ${opts.max ?? DEFAULTS.max} sessions running at once).`;

  if (opts.tui === false || !ctx.interactive) {
    const dispatcher = await Dispatcher.start(ctx, client, bots, dispatcherOpts);
    const release = releaseOnExit(dispatcher);
    ctx.out(`${watching} Ctrl-C to stop.`);
    let version: string;
    try {
      version = await pollUntilUpdate(ctx, dispatcher, interval);
    } finally {
      await release();
    }
    return applyUpdate(ctx, version, ctx.out);
  }

  // The dispatcher's log lines go to the TUI's status line instead of scrolling under it.
  let message = watching;
  const quiet: Context = { ...ctx, out: (t) => void (message = t) };
  const dispatcher = await Dispatcher.start(quiet, client, bots, dispatcherOpts);
  const release = releaseOnExit(dispatcher);
  // An update closes the TUI, as quitting does; then it runs again on the new version.
  const closeTui = new AbortController();
  let version: string | undefined;
  void pollUntilUpdate(quiet, dispatcher, interval).then((v) => {
    version = v;
    closeTui.abort();
  });
  try {
    await showTui(
      {
        load: async () => ({ ...(await dispatcher.state()), message }),
        readLog: (id) => dispatcher.readLog(id),
      },
      closeTui.signal,
    );
  } finally {
    await release();
  }
  if (version) return applyUpdate(ctx, version, ctx.out);
  // Quitting stops everything, as Ctrl-C does without the TUI: interrupt the whole process group so
  // the claude sessions this dispatcher started stop with it.
  process.kill(0, "SIGINT");
}

/** The org to run for: --org, else the one this machine's runner already has (if the user is still in it), else a pick. */
async function runnerOrg(ctx: Context, client: LoopwayClient, flag: string | undefined): Promise<string> {
  if (flag) return flag;
  const saved = await savedRunnerOrg(ctx.configDir);
  const member = saved && (await client.listOrgs()).some((o) => o.slug === saved);
  return resolveOrg(ctx, client, member ? saved : undefined, "runner");
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

/**
 * Polls until a newer release of the CLI is out and the sessions running have finished, then returns its version.
 * On finding one it stops taking on work, so the sessions in flight can end. The server turning this version away
 * (`cli_outdated`) is a reason to look right away; otherwise the lookup is the update module's cached one.
 */
export async function pollUntilUpdate(
  ctx: Context,
  dispatcher: Dispatcher,
  interval: number,
  availableUpdate: typeof availableUpdateNow = availableUpdateNow,
): Promise<string> {
  let updating: string | undefined;
  let outdated = false;
  let forced = false;
  for (;;) {
    try {
      await dispatcher.tick();
    } catch (err) {
      outdated ||= err instanceof ApiError && err.code === "cli_outdated";
      // A flaky network shouldn't take down running sessions; try again next tick.
      ctx.out(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!updating && (updating = await availableUpdate(ctx, { force: outdated && !forced }))) {
      ctx.out(`loopway ${updating} is out: finishing the running sessions, then updating.`);
      dispatcher.drain();
    }
    // Forced once: if GitHub has nothing newer, asking again every poll won't change that.
    forced ||= outdated;
    outdated = false;
    if (updating && !dispatcher.busy) return updating;
    // Poll again after the interval, or as soon as a run exits so its slot goes to a waiting session.
    const timer = new AbortController();
    await Promise.race([
      sleep(interval * 1000, undefined, { signal: timer.signal }).catch(() => {}),
      dispatcher.slotFreed(),
    ]);
    timer.abort();
  }
}
