// bb-plugin-loopway: `loopway bots run` inside bb. While the plugin is enabled it runs this machine's bots
// for one loopway org, as the CLI does, except that each loopway thread's session is a bb thread instead of a
// headless `claude -p`: the plugin keeps a map between the two, starts a bb thread for a new loopway thread,
// and sends each later message to the bb thread its loopway thread already has.
//
// The polling, leasing, routing and delivery are the CLI's own Dispatcher; sessions.ts is the harness it runs.
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { LoopwayClient } from "@loopway/cli/src/client.js";
import { defaultConfigDir, loadConfig, loadGithubBot } from "@loopway/cli/src/config.js";
import { authedClient, type Context } from "@loopway/cli/src/context.js";
import { DEFAULTS, Dispatcher } from "@loopway/cli/src/bots/dispatcher.js";
import { ensureRunner } from "@loopway/cli/src/bots/runner.js";
import { botEnvEntries, writeGhConfig, type EnvEntry } from "./github.js";
import { BbSessions, METADATA_KEY, type LoopwayThreadInfo } from "./sessions.js";
import { buildSnapshot, RunnerStatus, rpcContract, STATE_CHANGED, type RunnerInfo, type Snapshot } from "./status.js";

export { rpcContract };

/** Where the bb runner keeps its runner id, run logs and the GitHub bot's gh config, apart from the CLI's. */
const runnerDir = () => join(defaultConfigDir(), "bb-runner");

/** Providers to give loopway threads' environment to, beside the ones bb lists when the plugin loads. */
const KNOWN_PROVIDERS = ["claude-code", "codex", "pi", "acp-cursor"];

/** The CLI's lease TTL default (see `defaultTtl` in bots-run.ts): several polls, at least 30s. */
const ttlFor = (interval: number) => Math.max(DEFAULTS.ttl, 6 * interval);

/** What the Loopway page, `bb loopway status` and the agent tools reach while the runner is going. */
interface Running {
  info: RunnerInfo;
  dispatcher: Dispatcher;
  sessions: BbSessions;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    project: { type: "project", label: "bb project new loopway threads start in" },
    org: {
      type: "string",
      label: "Loopway org slug (only needed if you belong to several)",
      default: "",
    },
    max: {
      type: "number",
      label: "Most loopway threads running at once",
      experimental_schema: z.number().int().min(1).max(50),
      default: DEFAULTS.max,
    },
    interval: {
      type: "number",
      label: "Seconds between polls",
      experimental_schema: z.number().int().min(1).max(3600),
      default: DEFAULTS.interval,
    },
    apiKey: {
      type: "string",
      label: "Loopway API key (defaults to `loopway login`'s)",
      secret: true,
    },
    leaseBots: {
      type: "boolean",
      label: "Take bot leases (read new messages and start threads); off, only deliver to this runner's threads",
      default: true,
    },
  });

  let running: Running | undefined;
  // The page refetches on this signal; a burst of log lines (runs starting and ending, say) makes one.
  let publish: ReturnType<typeof setTimeout> | undefined;
  const status = new RunnerStatus(() => {
    publish ??= setTimeout(() => {
      publish = undefined;
      bb.realtime.publish(STATE_CHANGED, null);
    }, 300);
  });
  bb.onDispose(() => clearTimeout(publish));
  const note = (text: string, level: "info" | "warn" = "info") => {
    bb.log[level](text);
    status.touch();
  };
  /** Aborted when the settings change, so the runner starts again with them. */
  let restart = new AbortController();
  settings.onChange((next, prev) => {
    // Bot leases switch on the running dispatcher, so the runs in flight carry on undisturbed.
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== prev[k]);
    if (running && changed.length === 1 && changed[0] === "leaseBots") {
      running.dispatcher.setLeaseBots(next.leaseBots);
      return;
    }
    restart.abort();
  });

  const initial = await settings.get();
  if (!initial.project)
    bb.status.needsConfiguration(
      "Pick the bb project loopway threads start in: `bb plugin config loopway set project <project id>`.",
    );

  bb.background.service("runner", {
    async start(signal) {
      while (!signal.aborted) {
        restart = new AbortController();
        const stop = AbortSignal.any([signal, restart.signal]);
        status.set("starting");
        try {
          await runUntil(stop);
          status.set("stopped", signal.aborted ? "The plugin stopped." : "Restarting with the new settings.");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const configure = err instanceof Error && err.name === "NeedsConfigurationError";
          status.set(configure ? "needs-configuration" : "error", message);
          if (!configure) note(`runner stopped: ${message}`, "warn");
          throw err;
        } finally {
          running = undefined;
        }
      }
    },
  });

  /** One runner, with the settings as they are now, until `stop`. */
  async function runUntil(stop: AbortSignal): Promise<void> {
    const s = await settings.get();
    if (typeof s.project !== "string" || !s.project)
      throw needsConfiguration("Pick the bb project loopway threads start in.");
    // The bb runner keeps its own runner id and session logs, apart from the CLI's: a thread belongs to the
    // runner that claimed it, and only this one has bb threads to resume.
    const auth = await loadConfig(defaultConfigDir());
    const apiKey = typeof s.apiKey === "string" && s.apiKey ? s.apiKey : auth.api_key;
    if (!apiKey) throw needsConfiguration("Run `loopway login`, or set the plugin's apiKey setting.");
    const ctx: Context = {
      configDir: runnerDir(),
      env: { ...process.env, LOOPWAY_API_URL: auth.api_url, LOOPWAY_API_KEY: apiKey },
      interactive: false,
      out: (text) => note(text),
    };
    const client = await authedClient(ctx);
    const org = await pickOrg(client, s.org);
    const runner = await ensureRunner(ctx, client, org, `${hostname()} (bb)`);
    const all = (await client.listBots()).filter((b) => b.org_id === runner.org_id);
    const bots = all.filter((b) => b.prompt_version?.rules);

    const sessions = new BbSessions({
      threads: bb.sdk.threads,
      kv: bb.storage.kv,
      projectId: s.project,
      describe: (id) => describe(client, id),
      log: (text) => note(text),
      signal: stop,
    });
    const interval = s.interval;
    const dispatcher = await Dispatcher.start({ ...ctx, runAgent: sessions.run }, client, bots, {
      max: s.max,
      interval,
      ttl: ttlFor(interval),
      runnerId: runner.id,
      seen: all.map((b) => b.id),
      leaseBots: s.leaseBots,
    });
    running = {
      info: { org, runnerId: runner.id, projectId: s.project, interval, max: s.max },
      dispatcher,
      sessions,
    };
    status.set("running");
    note(`running ${bots.map((b) => b.name).join(", ") || "no bots yet"} for ${org} every ${interval}s`);
    try {
      while (!stop.aborted) {
        try {
          await dispatcher.tick();
        } catch (err) {
          // A flaky network shouldn't stop the runner; try again next tick.
          note(`error: ${err instanceof Error ? err.message : String(err)}`, "warn");
        }
        status.ticked();
        // Poll again after the interval, or as soon as a run ends so its slot goes to a waiting thread.
        const timer = new AbortController();
        await Promise.race([
          sleep(interval * 1000, undefined, { signal: AbortSignal.any([timer.signal, stop]) }).catch(() => {}),
          dispatcher.slotFreed(),
        ]);
        timer.abort();
      }
    } finally {
      // Gives the leases back so the CLI, or this plugin's next start, needn't wait out the TTL. bb threads
      // mid-turn carry on; the next start requeues what they were handed (see sessions.ts).
      await dispatcher.close();
    }
  }

  // A run waits on its bb thread; these say when to look again.
  bb.events.on("thread.idle", ({ thread }) => running?.sessions.poke(thread.id));
  bb.events.on("thread.failed", ({ thread }) => running?.sessions.poke(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => running?.sessions.forget(thread.id));

  // The environment `loopway bots run` gives its sessions, for the bb threads of loopway threads: they act on
  // GitHub as the loopway bot when one is configured (`loopway config update`), and their `loopway` calls never
  // update the CLI. Threads are known by the plugin metadata they're spawned with, which is there from their
  // first turn (the kv pair is written just after).
  const sessionEnv = async ({ threadId }: { threadId: string }): Promise<EnvEntry[]> => {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
    if (typeof metadata[METADATA_KEY] !== "string") return [];
    const entries = [{ name: "LOOPWAY_NO_UPDATE", value: "1", reason: "Only the runner updates the loopway CLI" }];
    let bot;
    try {
      bot = await loadGithubBot(defaultConfigDir(), process.env);
    } catch (err) {
      note(`not acting as the GitHub bot: ${err instanceof Error ? err.message : String(err)}`, "warn");
      throw err;
    }
    if (!bot) return entries;
    const dir = join(runnerDir(), "gh");
    await writeGhConfig(dir, bot);
    return [...entries, ...botEnvEntries(dir, bot)];
  };
  for (const id of await providerIds()) {
    try {
      bb.providers.experimental_contributeEnv(id, sessionEnv);
    } catch (err) {
      bb.log.warn(
        `can't give ${id} threads the loopway environment: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Every provider bb has now, and the usual ones, in case one registers after this plugin loads. */
  async function providerIds(): Promise<string[]> {
    const ids = new Set(KNOWN_PROVIDERS);
    try {
      for (const p of await bb.sdk.providers.list()) ids.add(p.id);
    } catch {
      // The usual ones will do.
    }
    return [...ids];
  }

  // The session tools `loopway bots run` gives each Claude Code session over MCP, as bb agent tools.
  const toolCall = async (bbThreadId: string, name: string, args: Record<string, unknown>) => {
    if (!running) throw new Error("The loopway runner isn't running.");
    const loopwayThreadId = await running.sessions.loopwayThreadFor(bbThreadId);
    if (!loopwayThreadId) throw new Error("This bb thread isn't a loopway thread.");
    return running.dispatcher.callTool(loopwayThreadId, name, args);
  };
  bb.agents.registerTool({
    name: "loopway_end",
    description:
      "Tell the loopway runner this thread's work is finished (the PR is merged or closed for good, or the user asked you to stop). It moves the loopway thread to done. A later event for the thread sends you a message again and makes it active again.",
    presentation: { label: { pending: "Ending the loopway thread", completed: "Ended the loopway thread" } },
    parameters: z.object({}),
    execute: (_args, { threadId }) => toolCall(threadId, "end", {}),
  });
  bb.agents.registerTool({
    name: "loopway_link",
    description:
      "Have this loopway thread track one more subject, so its events come to this thread. A subject another thread already holds can't be linked.",
    presentation: { label: { pending: "Linking a subject", completed: "Linked a subject" } },
    parameters: z.object({
      number: z.number().int().min(1).describe("the issue or PR number"),
      repo: z.string().optional().describe("owner/repo; defaults to this thread's repo"),
    }),
    execute: (args, { threadId }) => toolCall(threadId, "link", args),
  });
  bb.agents.configure((context) => {
    const id = context.pluginMetadata[METADATA_KEY];
    if (typeof id !== "string") return { tools: [], skills: [] };
    return {
      tools: ["loopway_end", "loopway_link"],
      skills: [],
      instructions: `This thread is the session of a loopway bot thread (id ${JSON.stringify(id)}); the loopway runner plugin sends it the thread's messages. Where your instructions say to call the \`end\` or \`link\` tool, call loopway_end or loopway_link.`,
    };
  });

  bb.cli.register(
    defineCli({
      name: "loopway",
      summary: "The loopway runner: which bots it runs and which bb thread each loopway thread is",
      commands: {
        status: cliCommand({
          summary: "Show the runner's org and bots, and each loopway thread's bb thread (at most 200 threads)",
          async run() {
            return { exitCode: 0, stdout: await statusText() };
          },
        }),
      },
    }),
  );

  /** The page's snapshot: the dispatcher's view of the bots and threads, with each thread's bb thread. */
  async function snapshot(): Promise<Snapshot> {
    const r = running;
    if (!r) return buildSnapshot({ status, pairs: new Map(), titles: new Map() });
    const pairs = new Map((await r.sessions.pairs()).map((p) => [p.loopwayThreadId, p.bbThreadId]));
    const titles = new Map<string, string | null>();
    try {
      const threads = await bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, limit: 500 });
      for (const t of threads) titles.set(t.id, t.title ?? t.titleFallback);
    } catch {
      // Titles are a nicety; the ids still link.
    }
    try {
      return buildSnapshot({ status, info: r.info, state: await r.dispatcher.state(), pairs, titles });
    } catch (err) {
      const stateError = err instanceof Error ? err.message : String(err);
      return buildSnapshot({ status, info: r.info, stateError, pairs, titles });
    }
  }

  bb.rpc.register(rpcContract, {
    state: () => snapshot(),
    async setLeaseBots({ on }) {
      const { leaseBots } = await settings.experimental_set({ leaseBots: on });
      return { leaseBots };
    },
  });

  async function statusText(): Promise<string> {
    const { runner, bots, threads, moreThreads, stateError } = await snapshot();
    if (runner.phase !== "running")
      return `The loopway runner is ${runner.phase}${runner.message ? `: ${runner.message}` : "."}\n`;
    const names = (lease: string) =>
      bots
        .filter((b) => b.lease === lease)
        .map((b) => b.name)
        .join(", ");
    const lines = [
      `org ${runner.org}, runner ${runner.runnerId}`,
      runner.leaseBots
        ? `bots: ${names("held") || "none"}`
        : `not taking bot leases: only delivering to this runner's threads`,
      ...bots.filter((b) => b.lease === "elsewhere").map((b) => `skipped ${b.name}: another runner holds its lease`),
      ...(stateError ? [`couldn't read the threads: ${stateError}`] : []),
      "",
      "loopway thread  status   bb thread         subjects",
      ...threads.map(
        (t) =>
          `${t.id.slice(0, 14).padEnd(16)}${t.status.padEnd(9)}${(t.bbThreadId ?? "-").padEnd(18)}${t.subjects.join(", ")}`,
      ),
    ];
    if (!threads.length) lines.push("(no threads yet)");
    if (moreThreads) lines.push(`… and ${moreThreads} more`);
    return lines.join("\n") + "\n";
  }
}

/** The org setting, else the user's only org. */
async function pickOrg(client: LoopwayClient, setting: string): Promise<string> {
  if (setting) return setting;
  const orgs = await client.listOrgs();
  if (orgs.length === 1) return orgs[0]!.slug;
  if (!orgs.length) throw needsConfiguration("You don't belong to any loopway org yet. Run `loopway username`.");
  throw needsConfiguration(
    `You belong to several loopway orgs (${orgs.map((o) => o.slug).join(", ")}): set the plugin's org setting.`,
  );
}

/** The bot prompt and a title for a loopway thread, from the bot that owns it. */
async function describe(client: LoopwayClient, loopwayThreadId: string): Promise<LoopwayThreadInfo | undefined> {
  for (const bot of await client.listBots()) {
    const thread = (await client.listThreads(bot.id, "all")).find((t) => t.id === loopwayThreadId);
    if (!thread) continue;
    return {
      prompt: bot.prompt_version?.prompt ?? "",
      title: thread.subjects.length ? `${bot.name}: ${thread.subjects.join(", ")}` : undefined,
    };
  }
  return undefined;
}

/** Puts the plugin in needs-configuration (matched by name); saving a setting tries again. */
function needsConfiguration(message: string): Error {
  return Object.assign(new Error(message), { name: "NeedsConfigurationError" });
}
