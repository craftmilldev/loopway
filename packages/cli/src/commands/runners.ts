import { authedClient, type Context } from "../context.js";
import { ago, dim, json, table } from "../format.js";

/** `loopway runners`: the machines that have run your bots, and the leases they hold. */
export async function listRunners(ctx: Context, opts: { json?: boolean }) {
  const client = await authedClient(ctx);
  const runners = await client.listRunners();
  if (opts.json) return ctx.out(json(runners));
  if (!runners.length) return ctx.out("No runners yet. `loopway bots run` registers this machine as one.");
  ctx.out(
    table(
      ["ID", "NAME", "BOTS", "THREADS", "LAST SEEN"],
      runners.map((r) => [
        r.id,
        r.name,
        r.bots.map((b) => b.name).join(", "),
        String(r.threads),
        dim(ago(r.last_seen_at)),
      ]),
    ),
  );
}
