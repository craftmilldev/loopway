import * as p from "@clack/prompts";
import { ApiError, LoopwayClient } from "../client.js";
import { clearConfig as removeConfig, configPath, loadConfig, resolveAuth, writeConfig } from "../config.js";
import { authedClient, CancelledError, UsageError, type Context } from "../context.js";
import { bold, dim, fields, json } from "../format.js";

/** Flags win; otherwise prompt (starting from the current URL) or, without a terminal, keep what's set. */
export async function configure(ctx: Context, opts: { url?: string; key?: string }) {
  const current = await loadConfig(ctx.configDir, ctx.env);
  const url = opts.url ?? (ctx.interactive ? await promptUrl(current.api_url) : current.api_url);
  const key = opts.key ?? (ctx.interactive ? await promptKey() : current.api_key);
  if (!key) throw new UsageError("--key (or LOOPWAY_API_KEY) is required when not running in a terminal");

  const client = new LoopwayClient({ baseUrl: url, apiKey: key, fetch: ctx.fetch });
  const user = await client.me().catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) throw new UsageError(`${url} rejected that API key.`);
    throw err;
  });
  await writeConfig(ctx.configDir, { api_url: url, api_key: key });
  ctx.out(`Configured ${url} as ${bold(user.name)}${user.email ? ` <${user.email}>` : ""}`);
  ctx.out(dim(`Saved to ${configPath(ctx.configDir)}`));
}

/** Emails a one-time code, trades it for an API key, and saves the key. Replaces the account's previous key. */
export async function login(ctx: Context, opts: { url?: string; email?: string; code?: string }) {
  const current = await loadConfig(ctx.configDir, ctx.env);
  const url = opts.url ?? current.api_url;
  const client = new LoopwayClient({ baseUrl: url, fetch: ctx.fetch });

  const email = opts.email ?? (ctx.interactive ? await promptEmail() : undefined);
  if (!email) throw new UsageError("--email is required when not running in a terminal");

  if (!opts.code) {
    await client.requestLoginCode(email);
    ctx.out(`If ${bold(email)} has a loopway account, a login code is on its way.`);
  }
  const code = opts.code ?? (ctx.interactive ? await promptCode() : undefined);
  if (!code) throw new UsageError("--code is required when not running in a terminal; request one by running `loopway login --email <email>` first and then re-run with it");

  const { api_key, user } = await client.verifyLoginCode(email, code).catch((err: unknown) => {
    if (err instanceof ApiError && err.code === "invalid_code") throw new UsageError(err.message);
    throw err;
  });
  await writeConfig(ctx.configDir, { api_url: url, api_key });
  ctx.out(`Logged in to ${url} as ${bold(user.name)}${user.email ? ` <${user.email}>` : ""}`);
  ctx.out(dim(`Saved to ${configPath(ctx.configDir)}`));
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

async function promptKey() {
  const v = await p.password({
    message: "API key (from `npm run user:create`)",
    validate: (v) => (v?.trim() ? undefined : "Required"),
  });
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
