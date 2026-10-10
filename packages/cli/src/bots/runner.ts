import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { LoopwayClient, Runner } from "../client.js";
import { readJson, writeJson } from "../config.js";

const runnerPath = (dir: string) => join(dir, "runner.json");

/**
 * This machine's runner: its id is made once and kept in ~/.loopway/runner.json, and the server is told about it
 * (named after the host) every time, which also marks it as seen.
 */
export async function ensureRunner(dir: string, client: LoopwayClient): Promise<Runner> {
  const saved = (await readJson(runnerPath(dir))) as { id?: unknown } | undefined;
  let id = typeof saved?.id === "string" ? saved.id : undefined;
  if (!id) {
    id = randomUUID();
    await writeJson(runnerPath(dir), { id });
  }
  return client.registerRunner({ id, name: hostname() });
}
