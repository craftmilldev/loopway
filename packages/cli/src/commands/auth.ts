import * as p from "@clack/prompts";
import { ApiError, LoopwayClient } from "../client.js";
import { clearConfig as removeConfig, configPath, loadConfig, resolveAuth, writeConfig } from "../config.js";
import { authedClient, CancelledError, UsageError, type Context } from "../context.js";
import { bold, dim, fields, json } from "../format.js";

/** Sets the API URL, PostHog host and auto-update: flags, else a prompt for the API URL, else what's set. */
export async function configure(
  ctx: Context,
  opts: {
    url?: string;
    posthogHost?: string;
    autoUpdate?: "on" | "off";
  },
) {
  const current = await loadConfig(ctx.configDir, ctx.env);
  const url = opts.url ?? (ctx.interactive ? await promptUrl(current.api_url) : current.api_url);
  await writeConfig(ctx.configDir, {
    api_url: url,
    ...(opts.posthogHost && { posthog_host: opts.posthogHost }),
    ...(opts.autoUpdate && { auto_update: opts.autoUpdate === "on" }),
  });
  ctx.out(`Configured ${url}. Run \`loopway login\` next.`);
  if (opts.autoUpdate) ctx.out(`Self-update: ${bold(opts.autoUpdate)}`);
  if (opts.posthogHost) ctx.out(`Metrics host: ${bold(opts.posthogHost)}`);
  ctx.out(dim(`Saved to ${configPath(ctx.configDir)}`));
  await ctx.metrics?.capture("config_updated", {
    url: !!opts.url,
    posthog_host: !!opts.posthogHost,
    auto_update: opts.autoUpdate ?? "unchanged",
  });
}

const MASK = "******";

/** Prints the settings commands would use, env included, with the API key masked. */
export async function showConfig(ctx: Context) {
  const config = await loadConfig(ctx.configDir, ctx.env);
  ctx.out(
    fields([
      ["api_url", config.api_url],
      ["api_key", config.api_key ? MASK : "(not logged in)"],
      ["posthog_host", config.posthog_host],
      ["auto_update", config.auto_update ? "on" : "off"],
    ]),
  );
  ctx.out(dim(`Config file: ${configPath(ctx.configDir)}`));
  await ctx.metrics?.capture("config_shown", {
    logged_in: !!config.api_key,
  });
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
  const authed = new LoopwayClient({ baseUrl: url, apiKey: token, fetch: ctx.fetch });
  if (!user.username) await chooseUsername(ctx, authed, opts.username);
  if (created)
    ctx.out(
      `\n${bold("Next:")} \`loopway inbox\` shows your inbox URL; \`loopway source types\` lists what can send to it.`,
    );
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

/** Sets or renames the username. */
export async function username(ctx: Context, name: string | undefined) {
  await chooseUsername(ctx, await authedClient(ctx), name);
}

/** The error codes a refused username comes back with. */
export const USERNAME_ERRORS = ["invalid_username", "username_reserved", "username_taken"];

/**
 * Saves `name`, or prompts for one until the server accepts it. Without a terminal and a name there is nothing to
 * ask, so that's a usage error that says how to finish.
 */
async function chooseUsername(ctx: Context, client: LoopwayClient, name: string | undefined): Promise<string> {
  for (let attempt = name; ; attempt = undefined) {
    const wanted = attempt ?? (ctx.interactive ? await promptUsername() : undefined);
    if (!wanted) throw new UsageError("A username is required: run `loopway username <name>` (or pass --username).");
    try {
      const user = await client.setUsername(wanted);
      ctx.out(`Your username is ${bold(user.username ?? wanted)}.`);
      return user.username ?? wanted;
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
