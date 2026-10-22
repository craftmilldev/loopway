import { loadConfig } from "../config.js";
import { authedClient, UsageError, type Context } from "../context.js";
import { ago, dim, json, table } from "../format.js";
import { defaultOrg } from "./orgs.js";

/** `loopway chats`: the org's chats with the manager, each recorded as a manager thread with the label of what it did. */
export async function listChats(ctx: Context, opts: { org?: string; json?: boolean }) {
  if (!(await loadConfig(ctx.configDir, ctx.env)).manager_enabled) {
    await ctx.metrics?.capture("chats_rejected", { reason: "manager_off" });
    throw new UsageError(
      "The manager is off, so there are no chats. Turn it on with `loopway config update --manager`.",
    );
  }
  const client = await authedClient(ctx);
  const chats = await client.listManagerThreads(await defaultOrg(ctx, client, opts.org, "bots"));
  await ctx.metrics?.capture("chats_listed", { count: chats.length, json: !!opts.json });
  if (opts.json) return ctx.out(json(chats));
  if (!chats.length) return ctx.out("No chats yet. Start one in the Chat view of `loopway bots run`.");
  ctx.out(
    table(
      ["ID", "LABEL", "ACTIONS", "STATUS", "STARTED"],
      chats.map((c) => [
        c.id,
        label(c.metadata.label) ?? dim("none"),
        actions(c.metadata.actions) || dim("none"),
        c.status === "ended" ? "ended" : "open",
        dim(ago(c.created_at)),
      ]),
    ),
  );
}

const label = (v: unknown) => (typeof v === "string" ? v : undefined);

/** `create 2, delete 1` from the thread's `actions` metadata. */
function actions(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  return Object.entries(v)
    .map(([kind, n]) => `${kind} ${String(n)}`)
    .join(", ");
}
