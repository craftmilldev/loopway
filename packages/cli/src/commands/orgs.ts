import * as p from "@clack/prompts";
import type { LoopwayClient } from "../client.js";
import { ApiError } from "../client.js";
import { authedClient, CancelledError, UsageError, type Context } from "../context.js";
import { bold, dim, json, table } from "../format.js";
import { readSavedOrg, writeSavedOrg } from "../config.js";
import { savedRunnerOrg } from "../bots/runner.js";
import { USERNAME_ERRORS } from "./auth.js";

export type OrgKind = "inbox" | "bot" | "runner" | "bots";

/** How an org was chosen, so the note under it can say how to choose another. */
type OrgSource = "flag" | "use" | "runner" | "only" | "picked";

const noted = new WeakMap<Context, Set<string>>();

/** Tells the user, once per command, which org the command is using and how to switch. */
function noteOrg(ctx: Context, slug: string, source: OrgSource) {
  const seen = noted.get(ctx) ?? new Set<string>();
  noted.set(ctx, seen);
  if (seen.has(slug)) return;
  seen.add(slug);
  const how =
    source === "use"
      ? `the org you chose with \`loopway orgs use\``
      : source === "runner"
        ? "the org this machine runs bots for"
        : source === "only"
          ? "your only org"
          : source === "picked"
            ? "the org you picked"
            : undefined;
  const line = how ? `org: ${slug} (${how}; switch with --org <slug> or \`loopway orgs use <slug>\`)` : `org: ${slug}`;
  (ctx.err ?? ((t: string) => process.stderr.write(t + "\n")))(dim(line));
}

/**
 * The slug of the org a command works in: `--org` if given, else (for `runner`) the one this machine runs bots for, else the one `loopway orgs use` saved, else (for
 * `bots`) the runner's, if the user is still in it. Otherwise the user's only
 * org, or in a terminal a pick from their orgs. With several orgs and no terminal there is no safe default, so it
 * names the slugs and the flag. Says which org it settled on, on stderr.
 */
export async function resolveOrg(
  ctx: Context,
  client: LoopwayClient,
  flag: string | undefined,
  kind: OrgKind,
): Promise<string> {
  if (flag) {
    noteOrg(ctx, flag, "flag");
    return flag;
  }
  const orgs = await client.listOrgs();
  const member = (slug: string | undefined) => (slug && orgs.some((o) => o.slug === slug) ? slug : undefined);
  // A machine keeps running the org its runner was registered for, even if `orgs use` has since looked elsewhere.
  const runner = kind === "runner" ? member(await savedRunnerOrg(ctx.configDir)) : undefined;
  if (runner) {
    noteOrg(ctx, runner, "runner");
    return runner;
  }
  const used = member(await readSavedOrg(ctx.configDir));
  if (used) {
    noteOrg(ctx, used, "use");
    return used;
  }
  const bots = kind === "bots" ? member(await savedRunnerOrg(ctx.configDir)) : undefined;
  if (bots) {
    noteOrg(ctx, bots, "runner");
    return bots;
  }
  if (orgs.length === 1) {
    noteOrg(ctx, orgs[0]!.slug, "only");
    return orgs[0]!.slug;
  }
  if (!orgs.length) throw new UsageError("You don't belong to any org yet. Choose a username with `loopway username`.");
  if (!ctx.interactive) {
    await ctx.metrics?.capture("org_unresolved", { kind, reason: "several_orgs_non_interactive" });
    throw new UsageError(
      `You belong to several orgs (${orgs.map((o) => o.slug).join(", ")}). Pass --org <slug> to choose ${
        kind === "runner"
          ? "the org to run bots for"
          : kind === "bots"
            ? "whose bots to use"
            : `where to use the ${kind}`
      }, or run \`loopway orgs use <slug>\` once.`,
    );
  }
  const picked = await p.select({
    message:
      kind === "runner"
        ? "Which org should this machine run bots for?"
        : kind === "bots"
          ? "Which org's bots?"
          : `Which org should the ${kind} belong to?`,
    options: orgs.map((o) => ({ value: o.slug, label: o.slug, hint: o.personal ? "personal" : undefined })),
  });
  if (p.isCancel(picked)) {
    await ctx.metrics?.capture("org_unresolved", { kind, reason: "cancelled" });
    p.cancel(kind === "runner" ? "Not running." : kind === "bots" ? "Cancelled." : `No ${kind} created.`);
    throw new CancelledError();
  }
  noteOrg(ctx, picked, "picked");
  return picked;
}

/**
 * The org a command can tell without asking: `--org`, the one `orgs use` saved, or the user's only org. For looking
 * up names to show next to ids, where being unsure should show the ids rather than stop the command.
 */
export async function orgIfKnown(ctx: Context, client: LoopwayClient, flag: string | undefined) {
  if (flag) return flag;
  const orgs = await client.listOrgs();
  const used = await readSavedOrg(ctx.configDir);
  if (used && orgs.some((o) => o.slug === used)) return used;
  return orgs.length === 1 ? orgs[0]!.slug : undefined;
}

/** `loopway orgs use [slug]`: the org commands work in when `--org` isn't given. Without a slug, says which it is. */
export async function useOrg(ctx: Context, slug: string | undefined, opts: { clear?: boolean }) {
  if (opts.clear) {
    await writeSavedOrg(ctx.configDir, undefined);
    await ctx.metrics?.capture("org_use_cleared", {});
    return ctx.out("Cleared. Commands go back to your only org, or ask when you have several.");
  }
  if (!slug) {
    const saved = await readSavedOrg(ctx.configDir);
    return ctx.out(
      saved
        ? `Commands use ${bold(saved)}. Switch with \`loopway orgs use <slug>\`.`
        : "No org chosen. Pick one with `loopway orgs use <slug>`.",
    );
  }
  const orgs = await (await authedClient(ctx)).listOrgs();
  const org = orgs.find((o) => o.slug === slug.trim().toLowerCase());
  if (!org) {
    await ctx.metrics?.capture("org_use_rejected", { reason: "not_a_member" });
    throw new UsageError(`You aren't in an org called "${slug}". Yours: ${orgs.map((o) => o.slug).join(", ")}.`);
  }
  await writeSavedOrg(ctx.configDir, org.slug);
  await ctx.metrics?.capture("org_use_saved", { personal: org.personal });
  ctx.out(`Commands now use ${bold(org.slug)} unless you pass --org.`);
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

export async function createOrg(ctx: Context, slug: string, opts: { name?: string; json?: boolean }) {
  try {
    const org = await (await authedClient(ctx)).createOrg(slug.trim().toLowerCase(), opts.name?.trim());
    await ctx.metrics?.capture("org_created", { named: !!opts.name });
    if (opts.json) return ctx.out(json(org));
    ctx.out(`Created ${bold(org.slug)}. Add people with \`loopway orgs add-member ${org.slug} <email>\`.`);
  } catch (err) {
    if (err instanceof ApiError && USERNAME_ERRORS.includes(err.code)) {
      await ctx.metrics?.capture("org_create_rejected", { reason: err.code });
      throw new UsageError(`${err.message}.`);
    }
    throw err;
  }
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
