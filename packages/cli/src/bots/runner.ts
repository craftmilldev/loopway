import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { ApiError, type LoopwayClient, type Runner } from "../client.js";
import { readJson, writeJson } from "../config.js";
import { UsageError, type Context } from "../context.js";

const runnerPath = (dir: string) => join(dir, "runner.json");

async function readSaved(dir: string): Promise<{ id?: string; org?: string }> {
  const saved = (await readJson(runnerPath(dir))) as { id?: unknown; org?: unknown } | undefined;
  return {
    id: typeof saved?.id === "string" ? saved.id : undefined,
    org: typeof saved?.org === "string" ? saved.org : undefined,
  };
}

/** The slug of the org this machine's runner was started for, if it has been remembered. */
export async function savedRunnerOrg(dir: string): Promise<string | undefined> {
  return (await readSaved(dir)).org;
}

/**
 * This machine's runner for the org: its id is made once and kept with the org in ~/.loopway/runner.json, and the
 * server is told about it (named after the host) every time, which also marks it as seen. A runner never changes org,
 * so asking for another org makes a new runner. A runner from before orgs were chosen has no org saved yet: if the
 * server says it belongs to another org, so does the error.
 */
export async function ensureRunner(
  ctx: Context,
  client: LoopwayClient,
  org: string,
  name = hostname(),
): Promise<Runner> {
  const saved = await readSaved(ctx.configDir);
  let id = saved.id;
  if (id && saved.org && saved.org !== org) {
    await ctx.metrics?.capture("runner_org_switched", {});
    id = undefined;
  }
  id ??= randomUUID();
  try {
    const runner = await client.registerRunner({ org, id, name });
    await writeJson(runnerPath(ctx.configDir), { id, org });
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
