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
import { defaultConfigDir, loadConfig } from "@loopway/cli/src/config.js";
import { authedClient, type Context } from "@loopway/cli/src/context.js";
import { DEFAULTS, Dispatcher } from "@loopway/cli/src/bots/dispatcher.js";
import { ensureRunner } from "@loopway/cli/src/bots/runner.js";
import { BbSessions, METADATA_KEY, type LoopwayThreadInfo } from "./sessions.js";

/** The CLI's lease TTL default (see `defaultTtl` in bots-run.ts): several polls, at least 30s. */
const ttlFor = (interval: number) => Math.max(DEFAULTS.ttl, 6 * interval);

/** What `bb loopway status` and the agent tools reach while the runner is going. */
interface Running {
  org: string;
  runnerId: string;
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
  });

  let running: Running | undefined;
  /** Aborted when the settings change, so the runner starts again with them. */
  let restart = new AbortController();
  settings.onChange(() => restart.abort());

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
        try {
          await runUntil(stop);
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
      configDir: join(defaultConfigDir(), "bb-runner"),
      env: { ...process.env, LOOPWAY_API_URL: auth.api_url, LOOPWAY_API_KEY: apiKey },
      interactive: false,
      out: (text) => bb.log.info(text),
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
      log: (text) => bb.log.info(text),
      signal: stop,
    });
    const interval = s.interval;
    const dispatcher = await Dispatcher.start({ ...ctx, runAgent: sessions.run }, client, bots, {
      max: s.max,
      interval,
      ttl: ttlFor(interval),
      runnerId: runner.id,
      seen: all.map((b) => b.id),
    });
    running = { org, runnerId: runner.id, dispatcher, sessions };
    bb.log.info(`running ${bots.map((b) => b.name).join(", ") || "no bots yet"} for ${org} every ${interval}s`);
    try {
      while (!stop.aborted) {
        try {
          await dispatcher.tick();
        } catch (err) {
          // A flaky network shouldn't stop the runner; try again next tick.
          bb.log.warn(`error: ${err instanceof Error ? err.message : String(err)}`);
        }
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
            return { exitCode: 0, stdout: await status() };
          },
        }),
      },
    }),
  );

  async function status(): Promise<string> {
    const r = running;
    if (!r) return "The loopway runner isn't running. See `bb plugin list` for why.\n";
    const state = await r.dispatcher.state();
    const pairs = new Map((await r.sessions.pairs()).map((p) => [p.loopwayThreadId, p.bbThreadId]));
    const lines = [
      `org ${r.org}, runner ${r.runnerId}`,
      `bots: ${state.bots.held.map((b) => b.name).join(", ") || "none"}`,
      ...state.bots.skipped.map((b) => `skipped ${b.name}: another runner holds its lease`),
      "",
      "loopway thread  status   bb thread         subjects",
    ];
    const mine = Object.values(state.threads).filter((t) => t.runner_id === r.runnerId);
    for (const t of mine.slice(0, 200)) {
      const flag = state.running.has(t.id) ? "running" : t.status;
      lines.push(
        `${t.id.slice(0, 14).padEnd(16)}${flag.padEnd(9)}${(pairs.get(t.id) ?? "-").padEnd(18)}${t.subjects.join(", ")}`,
      );
    }
    if (!mine.length) lines.push("(no threads yet)");
    if (mine.length > 200) lines.push(`… and ${mine.length - 200} more`);
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
