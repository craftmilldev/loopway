import { Command, InvalidArgumentError, Option } from "commander";
import { clearConfig, configure, login, showConfig, username, whoami } from "./commands/auth.js";
import { getMessage, listMessages, pushMessage } from "./commands/messages.js";
import { poll, read } from "./commands/read.js";
import { collect, parseDay, parseHour, readScheduleConfig } from "./commands/schedule.js";
import {
  listSources,
  listTypes,
  registerSource,
  removeSource,
  showInbox,
  showSource,
  updateSource,
} from "./commands/sources.js";
import { createToken, listTokens, revokeToken } from "./commands/tokens.js";
import { UsageError, type Context } from "./context.js";
import { updateBeforeCommand, updateCommand } from "./update.js";
import { CLI_VERSION } from "./version.js";

export function createProgram(ctx: Context): Command {
  const program = new Command("loopway")
    .description("Read your loopway inbox from the terminal.")
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

  // ---------- the inbox ----------

  program
    .command("inbox")
    .description("show your inbox: the one URL every sender is given")
    .addOption(jsonOpt())
    .action((opts) => showInbox(ctx, opts));

  // ---------- sources ----------

  const source = program
    .command("source")
    .alias("sources")
    .description("register the senders your inbox accepts, and the schedules that fill it");

  source
    .command("types")
    .description("list the types of source")
    .addOption(jsonOpt())
    .action((opts) => listTypes(ctx, opts));

  const scheduleOptions = (c: Command, add: string) =>
    c
      .option("--every <hour|day|week>", "schedule: how often it sends")
      .option("--hour <0-23>", "schedule: the UTC hour of a daily or weekly schedule", parseHour)
      .option("--day <0-6|mon..sun>", "schedule: the UTC weekday of a weekly schedule (0 is Sunday)", parseDay)
      .option("--message <type=text>", `schedule: ${add} a message type (repeatable)`, collect)
      .option("--message-file <type=path>", `schedule: ${add} a message type from a file (repeatable)`, collect)
      .option(
        "--config <file>",
        "schedule: the whole {schedule, messages} config from a JSON file",
        readScheduleConfig,
      );

  scheduleOptions(
    source
      .command("register")
      .description("register a sender's signing secret, or a schedule, with your inbox")
      .argument("<type>", "the source type: see `loopway source types`")
      .option("--name <name>", "a name for it, when you have several of a type (default: the type)")
      .option("--secret <secret>", "the signing secret (generated if the type lets loopway make it)"),
    "add",
  )
    .addOption(jsonOpt())
    .action((type, opts) => registerSource(ctx, type, opts));

  source
    .command("list", { isDefault: true })
    .alias("ls")
    .description("list your sources")
    .addOption(jsonOpt())
    .action((opts) => listSources(ctx, opts));

  source
    .command("show")
    .description("show a source and how its last delivery went")
    .argument("<source>", "source id or name")
    .addOption(jsonOpt())
    .action((ref, opts) => showSource(ctx, ref, opts));

  scheduleOptions(
    source
      .command("update")
      .description("change a source's name, secret or schedule (asks for the secret if no flags are given)")
      .argument("<source>", "source id or name")
      .option("--name <name>", "new name")
      .option("--secret <secret>", "the signing secret, e.g. the one the sender shows when you add the webhook"),
    "add or replace",
  )
    .option("--remove-message <type>", "schedule: remove a message type (repeatable)", collect)
    .addOption(jsonOpt())
    .action((ref, opts) => updateSource(ctx, ref, opts));

  source
    .command("remove")
    .alias("rm")
    .description("remove a source; its deliveries are refused from then on")
    .argument("<source>", "source id or name")
    .action((ref) => removeSource(ctx, ref));

  // ---------- reading ----------

  const sinceHelp = "start here instead: a time (ISO 8601), microseconds since the epoch, or how long ago (2h, 3d)";
  const typeHelp = "only this CloudEvent type, or a prefix ending in * (e.g. com.github.*)";

  program
    .command("read")
    .description("hand your reader every message since its last read, in order, then exit")
    .argument("<reader>", "a JS file whose default export takes a message")
    .option("--since <time>", sinceHelp)
    .option("--type <type>", typeHelp)
    .action((reader, opts) => read(ctx, reader, opts, stopSignal()));

  program
    .command("poll")
    .description("the same as read, and keep going until stopped")
    .argument("<reader>", "a JS file whose default export takes a message")
    .option("--since <time>", sinceHelp)
    .option("--type <type>", typeHelp)
    .option("--interval <seconds>", "seconds between polls; slows to once a minute when quiet (default 5)", positiveInt)
    .action((reader, opts) => poll(ctx, reader, opts, stopSignal()));

  program
    .command("push")
    .description("put a message in your inbox")
    .argument("<type>", "the CloudEvent type, e.g. build.finished")
    .option("--subject <subject>", "what it's about")
    .option("--id <id>", "a dedupe id: pushing it again stores nothing new")
    .option("--data <json>", "the message's data, as JSON")
    .option("--data-file <path>", "the same, from a file")
    .addOption(jsonOpt())
    .action((type, opts) => pushMessage(ctx, type, opts));

  const messages = program.command("messages").alias("message").description("look at your inbox's messages");

  messages
    .command("list", { isDefault: true })
    .alias("ls")
    .description("the newest messages, or with --since, everything from then on")
    .option("--since <time>", "a time (ISO 8601), microseconds since the epoch, or how long ago (2h, 3d)")
    .option("--type <type>", typeHelp)
    .option("--limit <n>", "page size (default 20, max 100)", positiveInt)
    .option("--all", "with --since: every page")
    .addOption(jsonOpt())
    .action((opts) => listMessages(ctx, opts));

  messages
    .command("get")
    .alias("show")
    .description("show one message and its payload")
    .argument("<message>", "message id")
    .option("--data", "print only the CloudEvent data (the webhook payload) as JSON")
    .addOption(jsonOpt())
    .action((id, opts) => getMessage(ctx, id, opts));

  // ---------- tokens ----------

  const token = program
    .command("token")
    .alias("tokens")
    .description("long-lived tokens, for what runs unattended (set one as LOOPWAY_API_KEY)");

  token
    .command("create")
    .description("make a token; it's shown once and doesn't expire")
    .argument("<name>", "what it's for")
    .addOption(jsonOpt())
    .action((name, opts) => createToken(ctx, name, opts));

  token
    .command("list", { isDefault: true })
    .alias("ls")
    .description("list your tokens")
    .addOption(jsonOpt())
    .action((opts) => listTokens(ctx, opts));

  token
    .command("revoke")
    .description("revoke a token")
    .argument("<token>", "token id or name")
    .action((ref) => revokeToken(ctx, ref));

  // ---------- gone in 1.0 ----------

  // A supervisor or a script may still run these after updating itself, so they say what happened.
  for (const name of ["bots", "bot", "runners", "runner", "chats", "orgs", "org"]) {
    program
      .command(name, { hidden: true })
      .allowUnknownOption()
      .allowExcessArguments()
      .action(() => {
        throw new UsageError(
          `\`loopway ${name}\` was removed in 1.0: loopway no longer runs bots. Write a reader instead, and run it with \`loopway poll\`. See https://github.com/craftmilldev/loopway/blob/main/CHANGELOG.md`,
        );
      });
  }

  return program;
}

/** Aborts on the first Ctrl-C or SIGTERM, so the message in hand finishes and its cursor is saved. */
function stopSignal(): AbortSignal {
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
  return stop.signal;
}

function positiveInt(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive integer");
  return n;
}
