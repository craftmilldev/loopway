import * as p from "@clack/prompts";
import type { LoopwayClient } from "../client.js";
import { ApiError } from "../client.js";
import { authedClient, CancelledError, UsageError, type Context } from "../context.js";
import { bold, dim, json, table } from "../format.js";

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

export async function listOrgs(ctx: Context, opts: { json?: boolean }) {
  const orgs = await (await authedClient(ctx)).listOrgs();
  if (opts.json) return ctx.out(json(orgs));
  if (!orgs.length) return ctx.out("You don't belong to any org yet. Choose a username with `loopway username`.");
  ctx.out(
    table(
      ["ORG", "KIND"],
      orgs.map((o) => [o.slug, o.personal ? dim("personal") : "shared"]),
    ),
  );
}

export async function orgMembers(ctx: Context, slug: string, opts: { json?: boolean }) {
  const { members, pending } = await (await authedClient(ctx)).listOrgMembers(slug);
  if (opts.json) return ctx.out(json({ members, pending }));
  ctx.out(
    table(
      ["USERNAME", "EMAIL", ""],
      [
        ...members.map((m) => [m.username ?? "", m.email ?? "", ""]),
        ...pending.map((email) => ["", email, dim("pending: joins when they first log in")]),
      ],
    ),
  );
}

export async function addOrgMember(ctx: Context, slug: string, email: string, opts: { json?: boolean }) {
  const client = await authedClient(ctx);
  const before = await client.listOrgMembers(slug);
  const addr = email.trim().toLowerCase();
  const after = await client.addOrgMember(slug, addr);
  if (opts.json) return ctx.out(json(after));
  const was = before.members.some((m) => m.email?.toLowerCase() === addr) || before.pending.includes(addr);
  const member = after.members.some((m) => m.email?.toLowerCase() === addr);
  ctx.out(
    was
      ? `${addr} is already ${member ? "a member of" : "invited to"} ${bold(slug)}.`
      : member
        ? `Added ${addr} to ${bold(slug)}.`
        : `${addr} has no account yet. They join ${bold(slug)} when they first log in.`,
  );
}

/** Removes a member by username or email, or withdraws a pending email. */
export async function removeOrgMember(ctx: Context, slug: string, who: string) {
  const client = await authedClient(ctx);
  const ref = who.trim().toLowerCase();
  const { members, pending } = await client.listOrgMembers(slug);
  const member = members.find((m) => m.username === ref || m.email?.toLowerCase() === ref);
  if (member) {
    await removeOrThrow(ctx, () => client.removeOrgMember(slug, member.id));
    return ctx.out(`Removed ${member.username ?? member.email} from ${bold(slug)}.`);
  }
  if (pending.includes(ref)) {
    await client.removeOrgInvite(slug, ref);
    return ctx.out(`Withdrew the invitation for ${ref} to ${bold(slug)}.`);
  }
  await ctx.metrics?.capture("org_member_not_found", { action: "remove" });
  throw new UsageError(`No member or pending email "${who}" in ${slug}. See \`loopway orgs members ${slug}\`.`);
}

export async function leaveOrg(ctx: Context, slug: string) {
  const client = await authedClient(ctx);
  const me = await client.me();
  await removeOrThrow(ctx, () => client.removeOrgMember(slug, me.id));
  ctx.out(`You left ${bold(slug)}.`);
}

/** Runs a removal; the last member of an org can't go, which is worth a clear message and a metric. */
async function removeOrThrow(ctx: Context, remove: () => Promise<void>) {
  try {
    await remove();
  } catch (err) {
    if (err instanceof ApiError && (err.code === "last_member" || err.code === "personal_owner")) {
      await ctx.metrics?.capture("org_remove_rejected", { reason: err.code });
      throw new UsageError(`${err.message}.`);
    }
    throw err;
  }
}
