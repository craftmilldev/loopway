import * as p from "@clack/prompts";
import type { LoopwayClient } from "../client.js";
import { CancelledError, UsageError, type Context } from "../context.js";

/**
 * The slug of the org to create in: `--org` if given. Otherwise the user's only org, or in a terminal a pick from
 * their orgs. With several orgs and no terminal there is no safe default, so it names the slugs and the flag.
 */
export async function resolveOrg(
  ctx: Context,
  client: LoopwayClient,
  flag: string | undefined,
  kind: "inbox" | "bot",
): Promise<string> {
  if (flag) return flag;
  const orgs = await client.listOrgs();
  if (orgs.length === 1) return orgs[0]!.slug;
  if (!orgs.length) throw new UsageError("You don't belong to any org yet. Choose a username with `loopway username`.");
  if (!ctx.interactive) {
    await ctx.metrics?.capture("org_unresolved", { kind, reason: "several_orgs_non_interactive" });
    throw new UsageError(
      `You belong to several orgs (${orgs.map((o) => o.slug).join(", ")}). Pass --org <slug> to choose where to create the ${kind}.`,
    );
  }
  const picked = await p.select({
    message: `Which org should the ${kind} belong to?`,
    options: orgs.map((o) => ({ value: o.slug, label: o.slug, hint: o.personal ? "personal" : undefined })),
  });
  if (p.isCancel(picked)) {
    await ctx.metrics?.capture("org_unresolved", { kind, reason: "cancelled" });
    p.cancel(`No ${kind} created.`);
    throw new CancelledError();
  }
  return picked;
}
