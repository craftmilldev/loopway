import { Command, InvalidArgumentError, Option } from "commander";
import { clearConfig, configure, login, whoami } from "./commands/auth.js";
import { listBotThreads, moveBotSubject, releaseBotThread } from "./commands/botThreads.js";
import {
  botMessages,
  botVersions,
  createBot,
  editBot,
  deleteBot,
  listBots,
  releaseBot,
  showBot,
  updateBot,
} from "./commands/bots.js";
import { getMessage, listMessages } from "./commands/messages.js";
import { createInbox, listInboxes, readSchema, showInbox, splitList, updateInbox } from "./commands/inboxes.js";
import { listRunners } from "./commands/runners.js";
import { runBots } from "./commands/bots-run.js";
import type { Context } from "./context.js";
import { PRESETS } from "@loopway/presets";

export function createProgram(ctx: Context): Command {
  const program = new Command("loopway")
    .description("Work with loopway inboxes and messages from the terminal.")
    .version("0.1.0")
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
Credentials are stored in ~/.loopway/config.json by \`loopway login\`.
LOOPWAY_API_URL and LOOPWAY_API_KEY override them.`,
    );

  program.hook("preAction", async (_, action) => {
    await ctx.metrics?.capture("cli_command", { command: action.name() });
  });

  const jsonOpt = () => new Option("--json", "print raw JSON");

  // ---------- auth ----------

  program
    .command("login")
    .description(
      "log in with an emailed one-time code and save a 30-day session token (creates an account for a new email)",
    )
    .option("--url <url>", "API base URL (default https://loopway.craftmill.dev)")
    .option("--email <email>", "your email (prompted for if omitted)")
    .option("--code <code>", "the 8-character code from the email (prompted for if omitted)")
    .action((opts) => login(ctx, opts));

  program
    .command("config")
    .description(
      "set the API URL, and the GitHub bot for `loopway bots run`, in ~/.loopway/config.json; run `loopway login` after",
    )
    .option("--url <url>", "API base URL, e.g. https://loopway.example.com (prompted for if omitted)")
    .option("--github-token <token>", "token for the GitHub bot that `loopway bots run` sessions act as")
    .option("--github-name <name>", "the bot's git author name")
    .option("--github-email <email>", "the bot's git author email")
    .action((opts) => configure(ctx, opts));

  program
    .command("clear-config")
    .description("delete ~/.loopway/config.json")
    .action(() => clearConfig(ctx));

  program
    .command("whoami")
    .description("show the current user")
    .addOption(jsonOpt())
    .action((opts) => whoami(ctx, opts));

  // ---------- inboxes ----------

  const inbox = program.command("inbox").alias("inboxes").description("create, list and update inboxes");

  inbox
    .command("create")
    .description("create an inbox (interactive; pass flags to skip prompts)")
    .option("--name <name>", "inbox name")
    .option("--source <type>", "source type (run without it to pick from the list)")
    .option("--events <list>", "comma-separated event names to accept (default all)", splitList)
    .option(
      "--secret <secret>",
      "webhook secret (generated if omitted, or for senders that make their own, the one they show)",
    )
    .option("--schema <file>", "JSON Schema file messages must match (loopway source)", readSchema)
    .addOption(jsonOpt())
    .action((opts) => createInbox(ctx, opts));

  inbox
    .command("update")
    .description("change an inbox's name, events, secret or schema (asks for the secret if no flags are given)")
    .argument("<inbox>", "inbox id or name")
    .option("--name <name>", "new name")
    .option("--events <list>", "comma-separated event names to accept, or *", splitList)
    .option("--secret <secret>", "webhook secret, e.g. the one the sender shows when you add the webhook")
    .option("--schema <file>", "JSON Schema file messages must match (loopway source)", readSchema)
    .addOption(jsonOpt())
    .action((ref, opts) => updateInbox(ctx, ref, opts));

  inbox
    .command("list")
    .alias("ls")
    .description("list your inboxes")
    .addOption(jsonOpt())
    .action((opts) => listInboxes(ctx, opts));

  inbox
    .command("show")
    .description("show an inbox, its webhook setup, and message counts")
    .argument("<inbox>", "inbox id or name")
    .addOption(jsonOpt())
    .action((ref, opts) => showInbox(ctx, ref, opts));

  // ---------- messages ----------

  const messages = program.command("messages").alias("message").description("read an inbox's messages");

  messages
    .command("list")
    .alias("ls")
    .description("list messages")
    .argument("<inbox>", "inbox id or name")
    .option("--type <type>", "exact CloudEvent type, or a prefix ending in * (e.g. com.github.pull_request.*)")
    .option("--limit <n>", "page size (max 100)", positiveInt)
    .addOption(new Option("--order <order>", "sort by arrival").choices(["asc", "desc"]))
    .option("--cursor <cursor>", "next_cursor from a previous page")
    .option("--all", "follow cursors and print every page")
    .addOption(jsonOpt())
    .action((ref, opts) => listMessages(ctx, ref, opts));

  messages
    .command("get")
    .alias("show")
    .description("show one message and its payload")
    .argument("<inbox>", "inbox id or name")
    .argument("<message>", "message id")
    .option("--data", "print only the CloudEvent data (the webhook payload) as JSON")
    .addOption(jsonOpt())
    .action((ref, id, opts) => getMessage(ctx, ref, id, opts));

  // ---------- runners ----------

  program
    .command("runners")
    .alias("runner")
    .description("list the machines that run your bots, and the bots and threads each holds")
    .addOption(jsonOpt())
    .action((opts) => listRunners(ctx, opts));

  // ---------- bots ----------

  const bots = program.command("bots").alias("bot").description("create, list, update and run bots");
  const inboxesOpt = (desc: string) => new Option("--inbox <list>", desc).argParser(splitList);

  bots
    .command("create")
    .description("create a bot that reads the given inboxes, starting from their newest message")
    .option("--name <name>", "bot name")
    .addOption(
      new Option("--preset <preset>", "template for the bot's first prompt and rules")
        .choices(Object.keys(PRESETS))
        .default("github-threads"),
    )
    .option("--model <model>", "model its sessions run on: an alias (sonnet, opus) or a full model id")
    .addOption(inboxesOpt("comma-separated inbox ids or names"))
    .addOption(jsonOpt())
    .action((opts) => createBot(ctx, opts));

  bots
    .command("list")
    .alias("ls")
    .description("list your bots")
    .addOption(jsonOpt())
    .action((opts) => listBots(ctx, opts));

  bots
    .command("show")
    .description("show a bot, its inboxes and its cursor")
    .argument("<bot>", "bot id or name")
    .option("--prompt", "print the bot's current prompt instead")
    .option("--rules", "print the bot's current assign rules (JSON) instead")
    .addOption(jsonOpt())
    .action((ref, opts) => showBot(ctx, ref, opts));

  bots
    .command("versions")
    .description("list the saved versions of a bot's prompt and rules, newest first")
    .argument("<bot>", "bot id or name")
    .addOption(jsonOpt())
    .action((ref, opts) => botVersions(ctx, ref, opts));

  bots
    .command("edit")
    .description("save a new version of a bot's prompt and/or rules, read from files; a running bot picks it up")
    .argument("<bot>", "bot id or name")
    .option("--prompt-file <path>", "the new prompt (Markdown)")
    .option("--rules-file <path>", "the new assign rules (JSON, as `bots show --rules` prints them)")
    .addOption(jsonOpt())
    .action((ref, opts) => editBot(ctx, ref, opts));

  bots
    .command("update")
    .description("rename a bot, change its model, or replace its inboxes")
    .argument("<bot>", "bot id or name")
    .option("--name <name>", "new name")
    .option("--model <model>", "new model; applies to runs that start after `loopway bots run` is restarted")
    .addOption(inboxesOpt("comma-separated inbox ids or names; replaces the bot's inboxes"))
    .addOption(jsonOpt())
    .action((ref, opts) => updateBot(ctx, ref, opts));

  bots
    .command("delete")
    .alias("rm")
    .description("delete a bot")
    .argument("<bot>", "bot id or name")
    .action((ref) => deleteBot(ctx, ref));

  bots
    .command("release")
    .description("drop the lease a runner left on a bot when it died, so the next `loopway bots run` can take it")
    .argument("<bot>", "bot id or name")
    .option("--force", "confirm: a `loopway bots run` still holding the lease loses the bot")
    .action((ref, opts) => releaseBot(ctx, ref, opts));

  bots
    .command("messages")
    .description("list the messages the bot would read next (after its cursor, oldest first)")
    .argument("<bot>", "bot id or name")
    .option("--limit <n>", "how many (default 50, max 100)", positiveInt)
    .addOption(jsonOpt())
    .action((ref, opts) => botMessages(ctx, ref, opts));

  const botThreads = bots
    .command("threads")
    .description("list a bot's threads on the server")
    .argument("<bot>", "bot id or name")
    .addOption(new Option("--status <status>", "which threads (default active)").choices(["active", "ended", "all"]))
    .addOption(jsonOpt())
    .action((ref, opts) => listBotThreads(ctx, ref, opts));

  botThreads
    .command("release")
    .description("give up a thread whose runner is gone, so another runner can claim it")
    .argument("<bot>", "bot id or name")
    .argument("<thread>", "thread id")
    .action((ref, thread) => releaseBotThread(ctx, ref, thread));

  botThreads
    .command("move")
    .description(
      "move a subject from one of the bot's threads to another, with its waiting messages; an ended thread resumes",
    )
    .argument("<bot>", "bot id or name")
    .argument("<subject>", "the subject, e.g. owner/repo#12")
    .argument("<from-thread>", "id of the thread it is on (the start of it is enough)")
    .argument("<to-thread>", "id of the thread to move it to (the start of it is enough)")
    .action((ref, subject, from, to) => moveBotSubject(ctx, ref, subject, from, to));

  bots
    .command("run")
    .description(
      "run your bots: read each one's messages and hand them to a Claude Code session per issue/PR thread, starting one if none matches",
    )
    .option(
      "--max <n>",
      "most sessions running at once; sessions waiting on their thread don't count (default 3)",
      positiveInt,
    )
    .option("--interval <seconds>", "seconds between polls (default 5)", positiveInt)
    .addOption(
      new Option(
        "--ttl <seconds>",
        "how long each bot lease lasts; it is renewed every poll (default 6 × --interval, at least 30; max 43200)",
      ).argParser(positiveInt),
    )
    .option("--no-tui", "print a plain log instead of the full-screen view of threads and their transcripts")
    .action((opts) => runBots(ctx, opts));

  return program;
}

function positiveInt(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive integer");
  return n;
}
