import { Command, InvalidArgumentError, Option } from "commander";
import { LIST_STATUSES } from "./client.js";
import { clearConfig, configure, login, whoami } from "./commands/auth.js";
import { getEvent, listEvents, lockEvent, markProcessed, nextEvent, unlockEvent } from "./commands/events.js";
import { createInbox, listInboxes, showInbox, splitList } from "./commands/inboxes.js";
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
    .description("log in with an emailed one-time code and save the API key (replaces your previous key)")
    .option("--url <url>", "API base URL (default https://loopway.craftmill.dev)")
    .option("--email <email>", "your account's email (prompted for if omitted)")
    .option("--code <code>", "the 6-digit code from the email (prompted for if omitted)")
    .action((opts) => login(ctx, opts));

  program
    .command("config")
    .description("set the API URL and key in ~/.loopway/config.json")
    .option("--url <url>", "API base URL, e.g. https://loopway.example.com")
    .option("--key <api_key>", "API key (prompted for if omitted; LOOPWAY_API_KEY also works)")
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

  const inbox = program.command("inbox").alias("inboxes").description("create and list inboxes");

  inbox
    .command("create")
    .description("create an inbox (interactive; pass flags to skip prompts)")
    .option("--name <name>", "inbox name")
    .option("--source <type>", "source type, e.g. github")
    .option("--events <list>", "comma-separated event names to accept (github: default all)", splitList)
    .option("--secret <secret>", "webhook secret, 16+ chars (github: generated if omitted)")
    .addOption(jsonOpt())
    .action((opts) => createInbox(ctx, opts));

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

  return program;
}

function positiveInt(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive integer");
  return n;
}
