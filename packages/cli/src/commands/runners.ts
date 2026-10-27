import { authedClient, type Context } from "../context.js";
import { resolveOrg } from "./orgs.js";
import { ago, dim, json, table } from "../format.js";

/** `loopway runners`: the machines that have run your bots. */
export async function listRunners(ctx: Context, opts: { json?: boolean; org?: string }) {
  const client = await authedClient(ctx);
  const runners = await client.listRunners(await resolveOrg(ctx, client, opts.org, "bots"));
  if (opts.json) return ctx.out(json(runners));
  if (!runners.length) return ctx.out("No runners yet. `loopway bots run` registers this machine as one.");
  ctx.out(
    table(
      ["ID", "NAME", "ORG", "THREADS", "LAST SEEN"],
      runners.map((r) => [r.id, r.name, r.org, String(r.threads), dim(ago(r.last_seen_at))]),
    ),
  );
}
