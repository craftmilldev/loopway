import { Command, InvalidArgumentError, Option } from "commander";
import { clearConfig, configure, login, showConfig, username, whoami } from "./commands/auth.js";
import {
  endBotThread,
  listBotThreads,
  moveBotSubject,
  releaseBotThread,
  sendBotThreadMessage,
  showBotThread,
} from "./commands/botThreads.js";
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
import {
  collect,
  createInbox,
  listInboxes,
  parseHour,
  readScheduleConfig,
  readSchema,
  showInbox,
  splitList,
  updateInbox,
} from "./commands/inboxes.js";
import { listChats } from "./commands/chats.js";
import { listRunners } from "./commands/runners.js";
import { runBots } from "./commands/bots-run.js";
import { addOrgMember, createOrg, leaveOrg, listOrgs, orgMembers, removeOrgMember, useOrg } from "./commands/orgs.js";
import { HARNESSES } from "@loopway/harnesses";
import type { Context } from "./context.js";
import { PRESETS } from "@loopway/presets";
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
  const orgOpt = (what: string) =>
    new Option(
      "--org <slug>",
      `org ${what} (the one \`loopway orgs use\` chose, else your only org; prompted for if unsure)`,
    );

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
    .description("set your username (the slug of your personal org), or change it; prompted for if omitted")
    .action((name) => username(ctx, name));

  const config = program
    .command("config")
    .description("show the settings the CLI uses (secrets masked), or change them with `loopway config update`")
    .action(() => showConfig(ctx));

  config
    .command("update")
    .description(
      "set the API URL, metrics host, self-update, the manager bot and the GitHub bot for `loopway bots run` in ~/.loopway/config.json; run `loopway login` after",
    )
    .option("--url <url>", "API base URL, e.g. https://loopway.example.com (prompted for if omitted)")
    .option("--posthog-host <url>", "where product metrics go (default: the API's /api/ingest proxy)")
    .option("--github-token <token>", "token for the GitHub bot that `loopway bots run` sessions act as")
    .option("--github-name <name>", "the bot's git author name")
    .option("--github-email <email>", "the bot's git author email")
    .addOption(
      new Option("--auto-update <on|off>", "whether the CLI updates itself to the latest release (default on)").choices(
        ["on", "off"],
      ),
    )
    .option("--manager", "turn the manager bot on")
    .option("--no-manager", "turn the manager bot off")
    .option("--manager-harness <name>", "the harness the manager runs on (default claude)")
    .option("--manager-model <name>", "the model the manager uses (default: the harness's)")
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

  // ---------- orgs ----------

  const orgs = program.command("orgs").alias("org").description("list your orgs, and manage who belongs to them");

  orgs
    .command("list", { isDefault: true })
    .alias("ls")
    .description("list your orgs (what `loopway orgs` does)")
    .addOption(jsonOpt())
    .action((opts) => listOrgs(ctx, opts));

  orgs
    .command("create")
    .description("create a shared org with you as its only member (slugs follow the username rules)")
    .argument("<slug>", "org slug: lowercase letters, numbers and hyphens")
    .option("--name <name>", "display name (default: the slug)")
    .addOption(jsonOpt())
    .action((slug, opts) => createOrg(ctx, slug, opts));

  orgs
    .command("members")
    .description("list an org's members and pending emails")
    .argument("<slug>", "org slug")
    .addOption(jsonOpt())
    .action((slug, opts) => orgMembers(ctx, slug, opts));

  orgs
    .command("add-member")
    .description(
      "add someone to an org by email (if they have no account yet, they join when they first log in). Personal orgs can't have other members",
    )
    .argument("<slug>", "org slug")
    .argument("<email>", "their email")
    .addOption(jsonOpt())
    .action((slug, email, opts) => addOrgMember(ctx, slug, email, opts));

  orgs
    .command("remove-member")
    .description("remove a member (or withdraw a pending email) from an org")
    .argument("<slug>", "org slug")
    .argument("<who>", "username or email")
    .action((slug, who) => removeOrgMember(ctx, slug, who));

  orgs
    .command("use")
    .description("choose the org commands work in when --org isn't given (without a slug, shows the current one)")
    .argument("[slug]", "org slug")
    .option("--clear", "forget the chosen org")
    .action((slug, opts) => useOrg(ctx, slug, opts));

  orgs
    .command("leave")
    .description("leave an org (its last member can't)")
    .argument("<slug>", "org slug")
    .action((slug) => leaveOrg(ctx, slug));

  // ---------- inboxes ----------

  const inbox = program.command("inbox").alias("inboxes").description("create, list and update inboxes");

  inbox
    .command("create")
    .description("create an inbox (interactive; pass flags to skip prompts)")
    .option("--name <name>", "inbox name")
    .option("--org <slug>", "org to create it in (your only org by default; prompted for if you have several)")
    .option("--source <type>", "source type (run without it to pick from the list)")
    .option("--events <list>", "comma-separated event names to accept (default all)", splitList)
    .option(
      "--secret <secret>",
      "webhook secret (generated if omitted, or for senders that make their own, the one they show)",
    )
    .option("--schema <file>", "JSON Schema file messages must match (loopway source)", readSchema)
    .option("--every <hour|day>", "schedule inbox: how often it sends")
    .option("--hour <0-23>", "schedule inbox: the UTC hour of a daily schedule", parseHour)
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
    .option("--every <hour|day>", "schedule inbox: how often it sends")
    .option("--hour <0-23>", "schedule inbox: the UTC hour of a daily schedule", parseHour)
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
    .addOption(orgOpt("the inbox is in, to find it by name"))
    .addOption(jsonOpt())
    .action((ref, opts) => updateInbox(ctx, ref, opts));

  inbox
    .command("list")
    .alias("ls")
    .description("list your inboxes")
    .addOption(orgOpt("whose inboxes to list"))
    .addOption(jsonOpt())
    .action((opts) => listInboxes(ctx, opts));

  inbox
    .command("show")
    .description("show an inbox, its webhook setup, and message counts")
    .argument("<inbox>", "inbox id or name")
    .addOption(orgOpt("the inbox is in, to find it by name"))
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
    .addOption(orgOpt("the inbox is in, to find it by name"))
    .addOption(jsonOpt())
    .action((ref, opts) => listMessages(ctx, ref, opts));

  messages
    .command("get")
    .alias("show")
    .description("show one message and its payload")
    .argument("<inbox>", "inbox id or name")
    .argument("<message>", "message id")
    .option("--data", "print only the CloudEvent data (the webhook payload) as JSON")
    .addOption(orgOpt("the inbox is in, to find it by name"))
    .addOption(jsonOpt())
    .action((ref, id, opts) => getMessage(ctx, ref, id, opts));

  // ---------- runners ----------

  program
    .command("runners")
    .alias("runner")
    .description("list the machines that run your bots, and the bots and threads each holds")
    .addOption(orgOpt("whose runners to list"))
    .addOption(jsonOpt())
    .action((opts) => listRunners(ctx, opts));

  // ---------- chats ----------

  program
    .command("chats")
    .description("list your org's chats with the manager bot (needs the manager on), each labelled by what it did")
    .option("--org <slug>", "the org (the one this machine runs bots for by default; prompted for if unsure)")
    .addOption(jsonOpt())
    .action((opts) => listChats(ctx, opts));

  // ---------- bots ----------

  const bots = program.command("bots").alias("bot").description("create, list, update and run bots");
  const botOrgOpt = () =>
    new Option(
      "--org <slug>",
      "org the bot is in, to find it by name (the one this machine runs bots for by default; prompted for if unsure)",
    );
  const harnessOpt = (desc: string) => new Option("--harness <harness>", desc).choices(HARNESSES.map((h) => h.name));
  const inboxesOpt = (desc: string) => new Option("--inbox <list>", desc).argParser(splitList);

  bots
    .command("create")
    .description("create a bot that reads the given inboxes, starting from their newest message")
    .option("--name <name>", "bot name")
    .option("--org <slug>", "org to create it in (your only org by default; prompted for if you have several)")
    .addOption(
      new Option("--preset <preset>", "template for the bot's first prompt and rules").choices(Object.keys(PRESETS)),
    )
    .option(
      "--model <model>",
      "model its sessions run on: an alias (sonnet, opus) or a full model id (not needed for --harness script)",
    )
    .addOption(harnessOpt("coding-agent CLI its sessions run in"))
    .addOption(inboxesOpt("comma-separated inbox ids or names"))
    .addOption(jsonOpt())
    .action((opts) => createBot(ctx, opts));

  bots
    .command("list")
    .alias("ls")
    .description("list an org's bots")
    .option(
      "--org <slug>",
      "org whose bots to list (the one this machine runs bots for by default; prompted for if unsure)",
    )
    .addOption(jsonOpt())
    .action((opts) => listBots(ctx, opts));

  bots
    .command("show")
    .description("show a bot, its inboxes and its cursor")
    .argument("<bot>", "bot id or name")
    .addOption(botOrgOpt())
    .option("--prompt", "print the bot's current prompt instead")
    .option("--rules", "print the bot's current assign rules (JSON) instead")
    .addOption(jsonOpt())
    .action((ref, opts) => showBot(ctx, ref, opts));

  bots
    .command("versions")
    .description("list the saved versions of a bot's prompt and rules, newest first")
    .argument("<bot>", "bot id or name")
    .addOption(botOrgOpt())
    .addOption(jsonOpt())
    .action((ref, opts) => botVersions(ctx, ref, opts));

  bots
    .command("edit")
    .description("save a new version of a bot's prompt and/or rules, read from files; a running bot picks it up")
    .argument("<bot>", "bot id or name")
    .addOption(botOrgOpt())
    .option("--prompt-file <path>", "the new prompt (Markdown)")
    .option("--rules-file <path>", "the new assign rules (JSON, as `bots show --rules` prints them)")
    .addOption(jsonOpt())
    .action((ref, opts) => editBot(ctx, ref, opts));

  bots
    .command("update")
    .description("rename a bot, change its model, or replace its inboxes")
    .argument("<bot>", "bot id or name")
    .addOption(botOrgOpt())
    .option("--name <name>", "new name")
    .option("--model <model>", "new model")
    .addOption(harnessOpt("new harness"))
    .addOption(inboxesOpt("comma-separated inbox ids or names; replaces the bot's inboxes"))
    .addOption(jsonOpt())
    .action((ref, opts) => updateBot(ctx, ref, opts));

  bots
    .command("delete")
    .alias("rm")
    .description("delete a bot")
    .argument("<bot>", "bot id or name")
    .addOption(botOrgOpt())
    .action((ref, opts) => deleteBot(ctx, ref, opts));

  bots
    .command("release")
    .description("drop the lease a runner left on a bot when it died, so the next `loopway bots run` can take it")
    .argument("<bot>", "bot id or name")
    .addOption(botOrgOpt())
    .option("--force", "confirm: a `loopway bots run` still holding the lease loses the bot")
    .action((ref, opts) => releaseBot(ctx, ref, opts));

  bots
    .command("messages")
    .description("list the messages the bot would read next (after its cursor, oldest first)")
    .argument("<bot>", "bot id or name")
    .addOption(botOrgOpt())
    .option("--limit <n>", "how many (default 50, max 100)", positiveInt)
    .addOption(jsonOpt())
    .action((ref, opts) => botMessages(ctx, ref, opts));

  const botThreads = bots
    .command("threads")
    .description("list a bot's threads on the server")
    .argument("<bot>", "bot id or name")
    .addOption(botOrgOpt())
    .addOption(new Option("--status <status>", "which threads (default active)").choices(["active", "ended", "all"]))
    .addOption(jsonOpt())
    .action((ref, opts) => listBotThreads(ctx, ref, opts));

  botThreads
    .command("show")
    .description("show one thread, with the metadata its session recorded")
    .argument("<bot>", "bot id or name")
    .argument("<thread>", "id of the thread (the start of it is enough)")
    .addOption(botOrgOpt())
    .addOption(jsonOpt())
    .action((ref: string, thread: string, _opts: unknown, cmd: Command) =>
      showBotThread(ctx, ref, thread, cmd.optsWithGlobals()),
    );

  botThreads
    .command("release")
    .description("give up a thread whose runner is gone, so another runner can claim it")
    .argument("<bot>", "bot id or name")
    .addOption(botOrgOpt())
    .argument("<thread>", "thread id")
    .action((ref, thread, _opts: unknown, cmd: Command) => releaseBotThread(ctx, ref, thread, cmd.optsWithGlobals()));

  botThreads
    .command("end")
    .description(
      "end a thread; its waiting and inflight messages stay as they are, its runner keeps its claim, and the next message for it resumes it",
    )
    .argument("<bot>", "bot id or name")
    .addOption(botOrgOpt())
    .argument("<thread>", "thread id")
    .addOption(jsonOpt())
    // The parent `threads` command takes --json too, and claims it wherever it appears.
    .action((ref: string, thread: string, _opts: unknown, cmd: Command) =>
      endBotThread(ctx, ref, thread, cmd.optsWithGlobals()),
    );

  botThreads
    .command("send")
    .description("send a message to a thread; its runner hands it to the thread's session")
    .argument("<bot>", "bot id or name")
    .addOption(botOrgOpt())
    .argument("<thread>", "id of the thread (the start of it is enough)")
    .argument("<text...>", "the message")
    .action((ref, thread, text, _opts: unknown, cmd: Command) =>
      sendBotThreadMessage(ctx, ref, thread, text, cmd.optsWithGlobals()),
    );

  botThreads
    .command("move")
    .description(
      "move a subject from one of the bot's threads to another, with its waiting messages; an ended thread resumes",
    )
    .argument("<bot>", "bot id or name")
    .addOption(botOrgOpt())
    .argument("<subject>", "the subject, e.g. owner/repo#12")
    .argument("<from-thread>", "id of the thread it is on (the start of it is enough)")
    .argument("<to-thread>", "id of the thread to move it to (the start of it is enough)")
    .action((ref, subject, from, to, _opts: unknown, cmd: Command) =>
      moveBotSubject(ctx, ref, subject, from, to, cmd.optsWithGlobals()),
    );

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
    .option(
      "--interval <seconds>",
      "seconds between polls right after activity; polling slows to once a minute when quiet (default 5)",
      positiveInt,
    )
    .addOption(
      new Option(
        "--ttl <seconds>",
        "how long each bot lease lasts; it is renewed every poll (default 6 × --interval, at least 180; max 43200)",
      ).argParser(positiveInt),
    )
    .option(
      "--org <slug>",
      "org whose bots to run (your only org by default; prompted for if you have several, then remembered). A runner belongs to one org: another --org starts a new runner",
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
