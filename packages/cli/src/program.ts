import { Command, InvalidArgumentError, Option } from "commander";
import { clearConfig, configure, login, showConfig, username, whoami } from "./commands/auth.js";
import { getMessage, listMessages } from "./commands/messages.js";
import {
  collect,
  createInbox,
  listInboxes,
  parseHour,
  parseDay,
  readScheduleConfig,
  readSchema,
  showInbox,
  splitList,
  testInbox,
  updateInbox,
} from "./commands/inboxes.js";
import type { Context } from "./context.js";
import { updateBeforeCommand, updateCommand } from "./update.js";
import { CLI_VERSION } from "./version.js";

export function createProgram(ctx: Context): Command {
  const program = new Command("loopway")
    .description("Work with loopway inboxes and messages from the terminal.")
    .version(CLI_VERSION)
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
Credentials are stored in ~/.loopway/config.json by \`loopway login\`.
LOOPWAY_API_URL and LOOPWAY_API_KEY override them.
A CLI installed from a release updates itself to the newest one; turn that off with
\`loopway config update --auto-update off\` or LOOPWAY_NO_UPDATE=1.`,
    );

  program.hook("preAction", async (_, action) => {
    await updateBeforeCommand(ctx);
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
    .option("--username <name>", "the username to claim on a new account (prompted for if omitted)")
    .action((opts) => login(ctx, opts));

  program
    .command("username [name]")
    .description("set your username, or change it; prompted for if omitted")
    .action((name) => username(ctx, name));

  const config = program
    .command("config")
    .description("show the settings the CLI uses (secrets masked), or change them with `loopway config update`")
    .action(() => showConfig(ctx));

  config
    .command("update")
    .description("set the API URL, metrics host and self-update in ~/.loopway/config.json; run `loopway login` after")
    .option("--url <url>", "API base URL, e.g. https://loopway.example.com (prompted for if omitted)")
    .option("--posthog-host <url>", "where product metrics go (default: Craftmill's shared proxy)")
    .addOption(
      new Option("--auto-update <on|off>", "whether the CLI updates itself to the latest release (default on)").choices(
        ["on", "off"],
      ),
    )
    .action((opts) => configure(ctx, opts));

  program
    .command("update")
    .description("install the newest release now, skipping the cached release lookup")
    .option("--force", "reinstall even if this is already the newest release")
    .action((opts) => updateCommand(ctx, opts));

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
    .option("--every <hour|day|week>", "schedule inbox: how often it sends")
    .option("--hour <0-23>", "schedule inbox: the UTC hour of a daily or weekly schedule", parseHour)
    .option("--day <0-6|mon..sun>", "schedule inbox: the UTC weekday of a weekly schedule (0 is Sunday)", parseDay)
    .option("--message <type=text>", "schedule inbox: a message type to send (repeatable)", collect)
    .option("--message-file <type=path>", "schedule inbox: a message type read from a file (repeatable)", collect)
    .option(
      "--config <file>",
      "schedule inbox: the whole {schedule, messages} config from a JSON file",
      readScheduleConfig,
    )
    .addOption(jsonOpt())
    .action((opts) => createInbox(ctx, opts));

  inbox
    .command("update")
    .description(
      "change an inbox's name, events, secret, schema, or a schedule inbox's schedule and messages (asks if no flags are given)",
    )
    .argument("<inbox>", "inbox id or name")
    .option("--name <name>", "new name")
    .option("--events <list>", "comma-separated event names to accept, or *", splitList)
    .option("--secret <secret>", "webhook secret, e.g. the one the sender shows when you add the webhook")
    .option("--schema <file>", "JSON Schema file messages must match (loopway source)", readSchema)
    .option("--every <hour|day|week>", "schedule inbox: how often it sends")
    .option("--hour <0-23>", "schedule inbox: the UTC hour of a daily or weekly schedule", parseHour)
    .option("--day <0-6|mon..sun>", "schedule inbox: the UTC weekday of a weekly schedule (0 is Sunday)", parseDay)
    .option("--message <type=text>", "schedule inbox: add or replace a message type (repeatable)", collect)
    .option(
      "--message-file <type=path>",
      "schedule inbox: add or replace a message type from a file (repeatable)",
      collect,
    )
    .option("--remove-message <type>", "schedule inbox: remove a message type (repeatable)", collect)
    .option(
      "--config <file>",
      "schedule inbox: replace the whole {schedule, messages} config from a JSON file",
      readScheduleConfig,
    )
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

  inbox
    .command("test")
    .description("send an inbox a sample message of its source, to see one arrive without setting up the sender")
    .argument("<inbox>", "inbox id or name")
    .addOption(jsonOpt())
    .action((ref, opts) => testInbox(ctx, ref, opts));

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

  return program;
}

function positiveInt(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive integer");
  return n;
}
