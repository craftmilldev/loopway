import * as p from "@clack/prompts";
import { HARNESSES } from "@loopway/harnesses";
import { ApiError, LoopwayClient } from "../client.js";
import {
  clearConfig as removeConfig,
  configPath,
  loadConfig,
  loadGithubBot,
  readGithubBot,
  readManagerSettings,
  resolveAuth,
  writeConfig,
  type GithubBot,
} from "../config.js";
import { authedClient, CancelledError, UsageError, type Context } from "../context.js";
import { bold, dim, fields, json } from "../format.js";

/**
 * Sets the API URL and the GitHub bot: flags, else prompts (starting from what's saved), else what's set.
 * Tokens are `loopway login`'s job, so it's the next step.
 */
export async function configure(
  ctx: Context,
  opts: {
    url?: string;
    posthogHost?: string;
    githubToken?: string;
    githubName?: string;
    githubEmail?: string;
    autoUpdate?: "on" | "off";
    manager?: boolean;
    managerHarness?: string;
    managerModel?: string;
  },
) {
  if (opts.managerHarness && !HARNESSES.some((h) => h.name === opts.managerHarness)) {
    await ctx.metrics?.capture("config_update_rejected", { reason: "unknown_manager_harness" });
    throw new UsageError(
      `Unknown harness "${opts.managerHarness}" (known: ${HARNESSES.map((h) => h.name).join(", ")})`,
    );
  }
  const current = await loadConfig(ctx.configDir, ctx.env);
  const url = opts.url ?? (ctx.interactive ? await promptUrl(current.api_url) : current.api_url);
  let github: GithubBot | undefined;
  try {
    github = await configureGithubBot(ctx, opts);
  } catch (err) {
    await ctx.metrics?.capture("config_update_rejected", { reason: "github_bot_incomplete" });
    throw err;
  }
  const setManager = opts.manager !== undefined || !!opts.managerHarness || !!opts.managerModel;
  const manager = setManager
    ? {
        ...(await readManagerSettings(ctx.configDir)),
        ...(opts.manager !== undefined && { enabled: opts.manager }),
        ...(opts.managerHarness && { harness: opts.managerHarness }),
        ...(opts.managerModel && { model: opts.managerModel }),
      }
    : undefined;
  await writeConfig(ctx.configDir, {
    api_url: url,
    ...(opts.posthogHost && { posthog_host: opts.posthogHost }),
    ...(github && { github }),
    ...(opts.autoUpdate && { auto_update: opts.autoUpdate === "on" }),
    ...(manager && { manager }),
  });
  ctx.out(`Configured ${url}. Run \`loopway login\` next.`);
  if (github) ctx.out(`GitHub bot: ${bold(github.name)} <${github.email}>`);
  if (opts.autoUpdate) ctx.out(`Self-update: ${bold(opts.autoUpdate)}`);
  if (manager) ctx.out(`Manager: ${bold(manager.enabled ? "on" : "off")}`);
  if (opts.posthogHost) ctx.out(`Metrics host: ${bold(opts.posthogHost)}`);
  ctx.out(dim(`Saved to ${configPath(ctx.configDir)}`));
  await ctx.metrics?.capture("config_updated", {
    url: !!opts.url,
    posthog_host: !!opts.posthogHost,
    github_bot: !!(opts.githubToken || opts.githubName || opts.githubEmail),
    auto_update: opts.autoUpdate ?? "unchanged",
    manager: opts.manager === undefined ? "unchanged" : opts.manager ? "on" : "off",
    manager_harness: !!opts.managerHarness,
    manager_model: !!opts.managerModel,
  });
}

const MASK = "******";

/** Prints the settings commands would use, env included, with the API key and GitHub token masked. */
export async function showConfig(ctx: Context) {
  const config = await loadConfig(ctx.configDir, ctx.env);
  let bot: GithubBot | undefined;
  let botError: string | undefined;
  try {
    bot = await loadGithubBot(ctx.configDir, ctx.env);
  } catch (err) {
    botError = (err as Error).message;
  }
  ctx.out(
    fields([
      ["api_url", config.api_url],
      ["api_key", config.api_key ? MASK : "(not logged in)"],
      ["posthog_host", config.posthog_host],
      ["auto_update", config.auto_update ? "on" : "off"],
      ["manager", config.manager_enabled ? "on" : "off"],
      ["manager_harness", config.manager_harness],
      ["manager_model", config.manager_model ?? "(default)"],
      ["github_token", bot ? MASK : botError ? "(incomplete)" : "(not set)"],
      ["github_name", bot?.name],
      ["github_email", bot?.email],
    ]),
  );
  if (botError) ctx.out(botError);
  ctx.out(dim(`Config file: ${configPath(ctx.configDir)}`));
  await ctx.metrics?.capture("config_shown", {
    logged_in: !!config.api_key,
    github_bot: !!bot,
    bot_incomplete: !!botError,
    manager: config.manager_enabled,
  });
}

/**
 * The bot from flags, else prompts (an empty answer keeps the saved value), else what config.json has.
 * Undefined when none of the three is set; a usage error when only some are, so nothing is saved.
 */
async function configureGithubBot(
  ctx: Context,
  opts: { githubToken?: string; githubName?: string; githubEmail?: string },
): Promise<GithubBot | undefined> {
  const saved = await readGithubBot(ctx.configDir);
  const token = opts.githubToken || (ctx.interactive ? await promptGithubToken(saved.token) : "") || saved.token;
  // Without a token there's no bot, so there's no point asking for its name and email.
  const ask = ctx.interactive && !!token;
  const name = opts.githubName || (ask ? await promptGithub("name", saved.name) : "") || saved.name;
  const email = opts.githubEmail || (ask ? await promptGithub("email", saved.email) : "") || saved.email;
  if (!token && !name && !email) return undefined;
  if (!token || !name || !email) {
    throw new UsageError(
      "The GitHub bot needs a token, name and email (--github-token, --github-name, --github-email).",
    );
  }
  return { token, name, email };
}

/** Emails a one-time code, trades it for a 30-day session token, and saves it (as `api_key` in the config). Creates the account if the email is new. */
export async function login(ctx: Context, opts: { url?: string; email?: string; code?: string; username?: string }) {
  const current = await loadConfig(ctx.configDir, ctx.env);
  const url = opts.url ?? current.api_url;
  const client = new LoopwayClient({ baseUrl: url, fetch: ctx.fetch });

  const email = opts.email ?? (ctx.interactive ? await promptEmail() : undefined);
  if (!email) throw new UsageError("--email is required when not running in a terminal");

  if (!opts.code) {
    await client.requestLoginCode(email);
    ctx.out(
      `A login code is on its way to ${bold(email)} (one is sent per 10 minutes; check your spam folder before asking again).`,
    );
  }
  const code = opts.code ?? (ctx.interactive ? await promptCode() : undefined);
  if (!code)
    throw new UsageError(
      "--code is required when not running in a terminal; request one by running `loopway login --email <email>` first and then re-run with it",
    );

  const { token, user, created } = await verify(ctx, client, email, code, opts.username?.trim().toLowerCase());
  await writeConfig(ctx.configDir, { api_url: url, api_key: token });
  ctx.out(
    `${created ? "Created your account and logged in to" : "Logged in to"} ${url} as ${bold(user.name)}${user.email ? ` <${user.email}>` : ""}`,
  );
  ctx.out(dim(`Saved to ${configPath(ctx.configDir)}`));

  // Signup asks for the username, so only an account from before that can lack one. The token is already saved.
  if (!user.username) {
    const authed = new LoopwayClient({ baseUrl: url, apiKey: token, fetch: ctx.fetch });
    await chooseUsername(ctx, authed, opts.username);
  }
}

/**
 * Verifies the code. An unknown email is a signup that needs a username: use `--username`, or ask for one (and ask
 * again if it's refused). The server keeps the code valid through username problems, so the same one is resent.
 */
async function verify(ctx: Context, client: LoopwayClient, email: string, code: string, username: string | undefined) {
  for (;;) {
    try {
      return await client.verifyLoginCode(email, code, username);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === "invalid_code") {
        await ctx.metrics?.capture("login_rejected", { reason: err.code });
        throw new UsageError(err.message);
      }
      if (err.code !== "username_required" && !USERNAME_ERRORS.includes(err.code)) throw err;
      await ctx.metrics?.capture(err.code === "username_required" ? "signup_username_missing" : "username_rejected", {
        reason: err.code,
      });
      if (!ctx.interactive) {
        throw new UsageError(
          err.code === "username_required"
            ? "This email has no account yet: pass --username <name> to sign up (the same code still works)."
            : err.message,
        );
      }
      if (err.code !== "username_required") ctx.out(err.message);
      username = await promptUsername();
    }
  }
}

/** Sets or renames the username (the slug of your personal org). */
export async function username(ctx: Context, name: string | undefined) {
  await chooseUsername(ctx, await authedClient(ctx), name);
}

/** The error codes a refused username or org slug comes back with. */
export const USERNAME_ERRORS = ["invalid_username", "username_reserved", "username_taken"];

/**
 * Saves `name`, or prompts for one until the server accepts it. Without a terminal and a name there is nothing to
 * ask, so that's a usage error that says how to finish.
 */
async function chooseUsername(ctx: Context, client: LoopwayClient, name: string | undefined) {
  for (let attempt = name; ; attempt = undefined) {
    const wanted = attempt ?? (ctx.interactive ? await promptUsername() : undefined);
    if (!wanted) throw new UsageError("A username is required: run `loopway username <name>` (or pass --username).");
    try {
      const user = await client.setUsername(wanted);
      ctx.out(`Your username is ${bold(user.username ?? wanted)}.`);
      return;
    } catch (err) {
      if (!(err instanceof ApiError) || !USERNAME_ERRORS.includes(err.code)) throw err;
      await ctx.metrics?.capture("username_rejected", { reason: err.code });
      if (!ctx.interactive) throw new UsageError(err.message);
      ctx.out(err.message);
    }
  }
}

export async function clearConfig(ctx: Context) {
  const removed = await removeConfig(ctx.configDir);
  ctx.out(removed ? `Removed ${configPath(ctx.configDir)}` : "Nothing to remove; no config saved.");
}

export async function whoami(ctx: Context, opts: { json?: boolean }) {
  const { api_url } = await resolveAuth(ctx.configDir, ctx.env);
  const user = await (await authedClient(ctx)).me();
  if (opts.json) return ctx.out(json({ ...user, api_url }));
  ctx.out(
    fields([
      ["name", user.name],
      ["username", user.username],
      ["email", user.email],
      ["id", user.id],
      ["api", api_url],
    ]),
  );
}

async function promptUrl(current: string) {
  const v = await p.text({
    message: "loopway API URL",
    initialValue: current,
    validate: (v) => {
      try {
        const u = new URL(v ?? "");
        return u.protocol === "http:" || u.protocol === "https:" ? undefined : "Must be an http(s) URL";
      } catch {
        return "Must be a URL";
      }
    },
  });
  if (p.isCancel(v)) throw new CancelledError();
  return v;
}

async function promptGithubToken(saved?: string) {
  const v = await p.password({
    message: saved ? "GitHub bot token (Enter keeps the saved one)" : "GitHub bot token (Enter for none)",
  });
  if (p.isCancel(v)) throw new CancelledError();
  return v.trim();
}

async function promptGithub(field: "name" | "email", saved?: string) {
  const v = await p.text({ message: `GitHub bot ${field}`, initialValue: saved });
  if (p.isCancel(v)) throw new CancelledError();
  return v.trim();
}

async function promptEmail() {
  const v = await p.text({
    message: "Email",
    validate: (v) => (/^\S+@\S+\.\S+$/.test(v?.trim() ?? "") ? undefined : "Enter an email address"),
  });
  if (p.isCancel(v)) throw new CancelledError();
  return v.trim();
}

async function promptCode() {
  const v = await p.text({
    message: "Login code from the email",
    validate: (v) => (/^[0-9A-Za-z -]{8,12}$/.test(v?.trim() ?? "") ? undefined : "Enter the 8-character code"),
  });
  if (p.isCancel(v)) throw new CancelledError();
  return v.trim();
}

async function promptUsername() {
  const v = await p.text({
    message: "Pick a username (lowercase letters, numbers and hyphens, 2-39 characters)",
    validate: (v) => (v?.trim() ? undefined : "Enter a username"),
  });
  if (p.isCancel(v)) throw new CancelledError();
  return v.trim().toLowerCase();
}
