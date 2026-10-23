import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { ApiError, type LoopwayClient, type Runner } from "../client.js";
import { readJson, writeJson } from "../config.js";
import { UsageError, type Context } from "../context.js";

const runnerPath = (dir: string) => join(dir, "runner.json");

interface Saved {
  /** The org this machine ran last: the default for the next run. */
  org?: string;
  /** The runner id for each org slug. */
  runners: Record<string, string>;
  /** A runner id from before orgs were saved: its org is unknown. */
  legacyId?: string;
}

async function readSaved(dir: string): Promise<Saved> {
  const saved = (await readJson(runnerPath(dir))) as { id?: unknown; org?: unknown; runners?: unknown } | undefined;
  const id = typeof saved?.id === "string" ? saved.id : undefined;
  const org = typeof saved?.org === "string" ? saved.org : undefined;
  const runners: Record<string, string> = {};
  if (saved?.runners && typeof saved.runners === "object") {
    for (const [slug, value] of Object.entries(saved.runners)) {
      if (typeof value === "string") runners[slug] = value;
    }
  }
  if (id && org && !runners[org]) runners[org] = id;
  return { org, runners, legacyId: id && !org ? id : undefined };
}

/** The slug of the org this machine's runner was started for, if it has been remembered. */
export async function savedRunnerOrg(dir: string): Promise<string | undefined> {
  return (await readSaved(dir)).org;
}

/**
 * This machine's runner for the org: one id per org, made once and kept in ~/.loopway/runner.json, and the server is
 * told about it (named after the host) every time, which also marks it as seen. A runner never changes org, so asking
 * for another org uses (or makes) that org's own runner and leaves the others alone. A runner from before orgs were
 * chosen has no org saved yet: if the server says it belongs to another org, so does the error.
 */
export async function ensureRunner(
  ctx: Context,
  client: LoopwayClient,
  org: string,
  name = hostname(),
): Promise<Runner> {
  const saved = await readSaved(ctx.configDir);
  if (saved.org && saved.org !== org) await ctx.metrics?.capture("runner_org_switched", {});
  let id = saved.runners[org] ?? saved.legacyId;
  if (!id) {
    id = randomUUID();
    await ctx.metrics?.capture("runner_created", {});
  }
  try {
    const runner = await client.registerRunner({ org, id, name });
    await writeJson(runnerPath(ctx.configDir), { org, runners: { ...saved.runners, [org]: id } });
    return runner;
  } catch (err) {
    if (err instanceof ApiError && err.code === "runner_org_mismatch") {
      await ctx.metrics?.capture("runner_org_mismatch", {});
      const owner = (err.details as { org?: string } | undefined)?.org;
      throw new UsageError(
        `This machine's runner belongs to ${owner ? `the org ${owner}` : "another org"}, not ${org}, and a runner can't move. ` +
          `${owner ? `Run \`loopway bots run --org ${owner}\` to keep using it, or d` : "D"}elete ${runnerPath(ctx.configDir)} to start a new runner for ${org}.`,
      );
    }
    throw err;
  }
}
