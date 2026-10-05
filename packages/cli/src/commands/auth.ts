import * as p from "@clack/prompts";
import { ApiError, LoopwayClient } from "../client.js";
import { clearConfig, configPath, readConfig, resolveAuth, writeConfig } from "../config.js";
import { authedClient, CancelledError, UsageError, type Context } from "../context.js";
import { bold, dim, fields, json } from "../format.js";

const DEFAULT_URL = "http://localhost:3000";

export async function login(ctx: Context, opts: { url?: string; key?: string }) {
  const existing = await readConfig(ctx.configDir);
  const url = opts.url ?? (ctx.interactive ? await promptUrl(existing?.api_url) : undefined);
  if (!url) throw new UsageError("--url is required when not running in a terminal");
  const key = opts.key ?? ctx.env.LOOPWAY_API_KEY ?? (ctx.interactive ? await promptKey() : undefined);
  if (!key) throw new UsageError("--key (or LOOPWAY_API_KEY) is required when not running in a terminal");

  const client = new LoopwayClient({ baseUrl: url, apiKey: key, fetch: ctx.fetch });
  const user = await client.me().catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) throw new UsageError(`${url} rejected that API key.`);
    throw err;
  });
  await writeConfig(ctx.configDir, { api_url: url.replace(/\/+$/, ""), api_key: key });
  ctx.out(`Logged in to ${url} as ${bold(user.name)}${user.email ? ` <${user.email}>` : ""}`);
  ctx.out(dim(`Saved to ${configPath(ctx.configDir)}`));
}

export async function logout(ctx: Context) {
  const removed = await clearConfig(ctx.configDir);
  ctx.out(removed ? `Logged out. Removed ${configPath(ctx.configDir)}` : "Not logged in.");
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

async function promptUrl(current?: string) {
  const v = await p.text({
    message: "loopway API URL",
    initialValue: current ?? DEFAULT_URL,
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
