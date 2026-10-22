import { setTimeout as sleep } from "node:timers/promises";
import { runHarness } from "@loopway/harnesses";
import { ApiError, type ThreadPatch } from "../client.js";
import { applyUpdate, availableUpdate as availableUpdateNow } from "../update.js";
import { loadConfig } from "../config.js";
import { authedClient, type Context } from "../context.js";
import { DEFAULTS, Dispatcher, MAX_POLL_INTERVAL, type ThreadsOptions } from "../bots/dispatcher.js";
import { ensureRunner } from "../bots/runner.js";
import { loadWorkdirs, WORKDIRS_FILE } from "../bots/workdirs.js";
import { resolveOrg } from "./orgs.js";
import { ManagerChat, MANAGER_MCP_TOOLS } from "../bots/chat.js";
import { startMcpServer } from "../mcp.js";
import { sessionTools } from "../bots/tools.js";
import { colorSupport } from "../bots/colors.js";
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
  const runner = await ensureRunner(ctx, client, await resolveOrg(ctx, client, opts.org, "runner"));
  const all = await client.listBots(runner.org);
  const bots = all.filter((b) => b.prompt_version?.rules);
  for (const b of all)
    if (!b.prompt_version?.rules) {
      ctx.out(`Skipping bot ${b.name}: it has no prompt and rules yet. Set them with \`loopway bots edit\`.`);
      void ctx.metrics?.capture("bot_skipped", { reason: "no_version" });
    }
  // The opt-in manager gives the TUI a Chat view, which is also what an empty runner opens in.
  const config = await loadConfig(ctx.configDir, ctx.env);
  const chatOn = config.manager_enabled && opts.tui !== false && ctx.interactive;
  if (!bots.length && !chatOn) {
    ctx.out(
      `No bots to run. Create one with \`loopway bots create --name <name> --preset <preset> --model <model> --inbox <inbox>\`.`,
    );
    return;
  }
  const interval = opts.interval ?? DEFAULTS.interval;
  // Bots the directory we run from gives their own working directory; checked now, so a bad file stops us here.
  const workdirs = await loadWorkdirs(process.cwd());
  if (workdirs.size) void ctx.metrics?.capture("bot_workdirs_loaded", { bots: workdirs.size });
  const dispatcherOpts = {
    ...opts,
    ttl: opts.ttl ?? defaultTtl(interval),
    runnerId: runner.id,
    org: runner.org,
    seen: all.map((b) => b.id),
    workdirs,
  };
  const names = bots.map((b) => b.name).join(", ") || "no bots";
  const dirs = workdirs.size
    ? ` Working directories from ${WORKDIRS_FILE} for ${workdirs.size} bot${workdirs.size === 1 ? "" : "s"}.`
    : "";
  const watching = `loopway ${CLI_VERSION}: running ${names} every ${interval}s, less when quiet (at most ${opts.max ?? DEFAULTS.max} sessions running at once).${dirs}`;

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
  // The manager's chats are manager threads of the org, written with this runner's lease. Its only MCP tools are
  // `record` and `unrecord`, bound to the thread of the session that calls them.
  const chatMcp = chatOn
    ? await startMcpServer(
        "loopway",
        sessionTools(
          {
            get: () => Promise.reject(new Error("The manager's thread can't be read.")),
            patch: (id, patch) => {
              // label and actions are the runner's, set from the approved changes; the manager can't touch them.
              const reserved = reservedChatKey(patch);
              if (reserved) {
                void ctx.metrics?.capture("record_rejected", { reason: "reserved_key" });
                return Promise.reject(new Error(`The key ${reserved} is set by the runner; pick another.`));
              }
              return dispatcher.patchManagerThread(id, patch);
            },
          },
          ctx.metrics,
        ).filter((t) => MANAGER_MCP_TOOLS.includes(t.name)),
      )
    : undefined;
  const chat = chatMcp
    ? new ManagerChat({
        org: runner.org,
        dir: ctx.configDir,
        env: ctx.env,
        harness: config.manager_harness,
        model: config.manager_model,
        runAgent: ctx.runAgent ?? runHarness,
        capture: (event, properties) => void ctx.metrics?.capture(event, properties),
        threads: {
          create: async (id) => void (await dispatcher.createManagerThread(id)),
          patch: async (id, patch) => void (await dispatcher.patchManagerThread(id, patch)),
          mcpUrl: (id) => chatMcp.urlFor(id),
        },
      })
    : undefined;
  const release = releaseOnExit(dispatcher, async () => {
    // The chat's thread ends while the runner's lease is still held.
    await chat?.close();
    await chatMcp?.close();
  });
  // An update closes the TUI, as quitting does; then it runs again on the new version.
  const closeTui = new AbortController();
  let version: string | undefined;
  void pollUntilUpdate(quiet, dispatcher, interval).then((v) => {
    version = v;
    closeTui.abort();
  });
  // How often the TUI's colors fall back to the 256-color palette, or go without.
  void ctx.metrics?.capture("bots_run_tui_opened", { colors: colorSupport() });
  try {
    await showTui(
      {
        org: runner.org,
        chat,
        startInChat: !bots.length,
        capture: (event, properties) => void ctx.metrics?.capture(event, properties),
        load: async () => ({ ...(await dispatcher.state()), message }),
        readLog: (id) => dispatcher.readLog(id),
        send: async (threadId, text) => {
          const botId = (await dispatcher.state()).threads[threadId]?.bot_id;
          if (!botId) throw new Error("unknown thread");
          try {
            await client.sendThreadMessage(botId, threadId, text);
          } catch (err) {
            const reason = err instanceof ApiError ? err.code : "error";
            void ctx.metrics?.capture("thread_message_failed", { surface: "tui", reason });
            throw err;
          }
          void ctx.metrics?.capture("thread_message_sent", { surface: "tui" });
        },
        end: async (threadId) => {
          const botId = (await dispatcher.state()).threads[threadId]?.bot_id;
          if (!botId) throw new Error("unknown thread");
          try {
            await client.endThread(botId, threadId);
            void ctx.metrics?.capture("thread_ended", { surface: "tui" });
          } catch (err) {
            const reason = err instanceof ApiError ? err.code : "error";
            void ctx.metrics?.capture("thread_end_failed", { surface: "tui", reason });
            throw err;
          }
        },
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

/**
 * The lease TTL when --ttl isn't given. The lease is renewed every poll, so it lasts several polls: one
 * slow renewal mustn't lose it. The floor keeps a tiny --interval from making it fragile.
 */
export const defaultTtl = (interval: number) => Math.max(DEFAULTS.ttl, 6 * interval, 3 * MAX_POLL_INTERVAL);

/**
 * Seconds to wait before the next poll: the --interval right after something happened, growing with the time
 * since, up to a minute, so a quiet runner asks the server far less often.
 */
export const pollDelay = (interval: number, idleMs: number) =>
  Math.min(Math.max(interval, idleMs / 1000), Math.max(interval, MAX_POLL_INTERVAL));

/** The metadata keys the runner sets on a chat's thread. */
const RESERVED_CHAT_KEYS = ["label", "actions"];

/** The first of the runner's keys a patch to a chat's metadata sets or removes, if any. */
export const reservedChatKey = (patch: Pick<ThreadPatch, "metadata_set" | "metadata_unset">) =>
  [...Object.keys(patch.metadata_set ?? {}), ...(patch.metadata_unset ?? [])].find((k) =>
    RESERVED_CHAT_KEYS.includes(k),
  );

/** How long an exit waits for the leases to be released before going ahead without. */
const RELEASE_TIMEOUT_MS = 5000;

/**
 * Gives the bot leases back however the process ends (Ctrl-C, a SIGTERM or SIGHUP from `kill`, a closed
 * terminal or a supervisor, a crash), so the next runner doesn't wait out the TTL. Returns the release
 * itself, for the exit paths that return: it runs once however often it's called, so a second Ctrl-C
 * joins the first instead of skipping it, and gives up after a few seconds so a lost network can't
 * hang the exit.
 */
function releaseOnExit(dispatcher: Dispatcher, before?: () => Promise<void>): () => Promise<void> {
  let releasing: Promise<void> | undefined;
  const release = () =>
    (releasing ??= Promise.race([
      (before?.().catch(() => {}) ?? Promise.resolve()).then(() => dispatcher.close()).catch(() => {}),
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
  let capped = false;
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
    // Poll again after a delay that grows while idle, or as soon as a run exits so its slot goes to a waiting session.
    const delay = pollDelay(interval, dispatcher.idleMs());
    // Only a delay that grew to the cap counts: an --interval above it never backed off.
    const atMax = delay >= MAX_POLL_INTERVAL && delay > interval;
    if (atMax && !capped) void ctx.metrics?.capture("bot_poll_backed_off_to_max");
    capped = atMax;
    const timer = new AbortController();
    await Promise.race([
      sleep(delay * 1000, undefined, { signal: timer.signal }).catch(() => {}),
      dispatcher.slotFreed(),
    ]);
    timer.abort();
  }
}
