import { Command, InvalidArgumentError, Option } from "commander";
import { LIST_STATUSES } from "./client.js";
import { clearConfig, configure, login, whoami } from "./commands/auth.js";
import { getEvent, listEvents, lockEvent, markProcessed, nextEvent, unlockEvent } from "./commands/events.js";
import { createInbox, listInboxes, showInbox, splitList, updateInbox } from "./commands/inboxes.js";
import { runThreads } from "./commands/threads.js";
import type { Context } from "./context.js";

export function createProgram(ctx: Context): Command {
  const program = new Command("loopway")
    .description("Work with loopway inboxes and events from the terminal.")
    .version("0.1.0")
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
Credentials are stored in ~/.loopway/config.json by \`loopway config\`.
LOOPWAY_API_URL and LOOPWAY_API_KEY override them.`,
    );

  const jsonOpt = () => new Option("--json", "print raw JSON");
  const ttlOpt = () => new Option("--ttl <seconds>", "lock duration (default 300, max 43200)").argParser(positiveInt);
  const tokenOpt = () => new Option("--token <lock_token>", "lock token (defaults to the one this machine holds)");

  // ---------- auth ----------

  program
    .command("login")
    .description("log in with an emailed one-time code and save a 30-day session token (creates an account for a new email)")
    .option("--url <url>", "API base URL (default https://loopway.craftmill.dev)")
    .option("--email <email>", "your email (prompted for if omitted)")
    .option("--code <code>", "the 8-character code from the email (prompted for if omitted)")
    .action((opts) => login(ctx, opts));

  program
    .command("config")
    .description("set the API URL and key in ~/.loopway/config.json")
    .option("--url <url>", "API base URL, e.g. https://loopway.example.com")
    .option("--key <api_key>", "token (prompted for if omitted; LOOPWAY_API_KEY also works)")
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
    .option("--secret <secret>", "webhook secret (generated if omitted, or for senders that make their own, the one they show)")
    .addOption(jsonOpt())
    .action((opts) => createInbox(ctx, opts));

  inbox
    .command("update")
    .description("change an inbox's name, events or secret (asks for the secret if no flags are given)")
    .argument("<inbox>", "inbox id or name")
    .option("--name <name>", "new name")
    .option("--events <list>", "comma-separated event names to accept, or *", splitList)
    .option("--secret <secret>", "webhook secret, e.g. the one the sender shows when you add the webhook")
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
    .description("show an inbox, its webhook setup, and event counts")
    .argument("<inbox>", "inbox id or name")
    .addOption(jsonOpt())
    .action((ref, opts) => showInbox(ctx, ref, opts));

  // ---------- events ----------

  const events = program.command("events").alias("event").description("read and process an inbox's events");

  events
    .command("list")
    .alias("ls")
    .description("list events")
    .argument("<inbox>", "inbox id or name")
    .addOption(new Option("--status <status>", "filter by status (default all)").choices(LIST_STATUSES))
    .option("--type <type>", "exact CloudEvent type, or a prefix ending in * (e.g. com.github.pull_request.*)")
    .option("--limit <n>", "page size (max 100)", positiveInt)
    .addOption(new Option("--order <order>", "sort by arrival").choices(["asc", "desc"]))
    .option("--cursor <cursor>", "next_cursor from a previous page")
    .option("--all", "follow cursors and print every page")
    .addOption(jsonOpt())
    .action((ref, opts) => listEvents(ctx, ref, opts));

  events
    .command("get")
    .alias("show")
    .description("show one event and its payload")
    .argument("<inbox>", "inbox id or name")
    .argument("<event>", "event id")
    .option("--data", "print only the CloudEvent data (the webhook payload) as JSON")
    .addOption(jsonOpt())
    .action((ref, id, opts) => getEvent(ctx, ref, id, opts));

  events
    .command("next")
    .description("claim the oldest pending event with a lock")
    .argument("<inbox>", "inbox id or name")
    .addOption(ttlOpt())
    .addOption(jsonOpt())
    .action((ref, opts) => nextEvent(ctx, ref, opts));

  events
    .command("lock")
    .description("lock an event, or extend a lock you hold")
    .argument("<inbox>", "inbox id or name")
    .argument("<event>", "event id")
    .addOption(ttlOpt())
    .addOption(tokenOpt())
    .addOption(jsonOpt())
    .action((ref, id, opts) => lockEvent(ctx, ref, id, opts));

  events
    .command("unlock")
    .description("release a lock; the event goes back to pending")
    .argument("<inbox>", "inbox id or name")
    .argument("<event>", "event id")
    .addOption(tokenOpt())
    .addOption(jsonOpt())
    .action((ref, id, opts) => unlockEvent(ctx, ref, id, opts));

  events
    .command("done")
    .alias("processed")
    .description("mark an event processed")
    .argument("<inbox>", "inbox id or name")
    .argument("<event>", "event id")
    .addOption(tokenOpt())
    .addOption(jsonOpt())
    .action((ref, id, opts) => markProcessed(ctx, ref, id, opts));

  // ---------- threads ----------

  program
    .command("threads")
    .alias("thread")
    .description("run a Claude Code session per issue/PR thread: poll an inbox and hand each pending event to its thread's session, starting one if none matches")
    .argument("<inbox>", "inbox id or name")
    .option("--max <n>", "most sessions running at once; sessions waiting on their thread don't count (default 3)", positiveInt)
    .option("--interval <seconds>", "seconds between polls (default 30)", positiveInt)
    .addOption(new Option("--ttl <seconds>", "lock duration while claiming an event, before it is marked processed (default 3600, max 43200)").argParser(positiveInt))
    .option("--no-tui", "print a plain log instead of the full-screen view of threads and their transcripts")
    .action((ref, opts) => runThreads(ctx, ref, opts));

  return program;
}

function positiveInt(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive integer");
  return n;
}
