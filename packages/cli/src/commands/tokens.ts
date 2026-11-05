import { authedClient, UsageError, type Context } from "../context.js";
import { ago, bold, dim, json, table } from "../format.js";

/** Makes a long-lived token, for what runs unattended: a `loopway poll` (as LOOPWAY_API_KEY) or an MCP client. */
export async function createToken(ctx: Context, name: string, opts: { json?: boolean }) {
  const made = await (await authedClient(ctx)).createToken(name);
  await ctx.metrics?.capture("api_token_created");
  if (opts.json) return ctx.out(json(made));
  ctx.out(`${bold(made.token)}\n${dim("Shown once. It doesn't expire: revoke it with `loopway token revoke`.")}`);
}

export async function listTokens(ctx: Context, opts: { json?: boolean }) {
  const rows = await (await authedClient(ctx)).listTokens();
  if (opts.json) return ctx.out(json(rows));
  if (!rows.length) return ctx.out("No tokens. Make one with `loopway token create <name>`.");
  ctx.out(
    table(
      ["ID", "NAME", "CREATED", "LAST USED"],
      rows.map((t) => [t.id, t.name, ago(t.created_at), t.last_used_at ? ago(t.last_used_at) : "never"]),
    ),
  );
}

export async function revokeToken(ctx: Context, ref: string) {
  const client = await authedClient(ctx);
  const match = (await client.listTokens()).find((t) => t.id === ref || t.name === ref);
  if (!match) throw new UsageError(`No token with id or name "${ref}". See \`loopway token list\`.`);
  await client.revokeToken(match.id);
  ctx.out(`Revoked ${match.name}.`);
}
