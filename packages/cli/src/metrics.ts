import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PostHog } from "posthog-node";
import { loadConfig } from "./config.js";
import { CLI_VERSION } from "./version.js";

/** Product metrics. Sends nothing unless POSTHOG_API_KEY is set, or if DO_NOT_TRACK / LOOPWAY_TELEMETRY=0 is. */
export interface Metrics {
  /** Records one event for this install. Never throws: metrics must not break a command. */
  capture(event: string, properties?: Record<string, unknown>): Promise<void>;
}

export const noopMetrics: Metrics = { capture: async () => {} };

/** The user id inside a session token (its `sub`), as the server uses it. Not verified: it only labels events. */
export function tokenUserId(token: string | undefined): string | undefined {
  try {
    const sub = (JSON.parse(Buffer.from(token?.split(".")[1] ?? "", "base64url").toString()) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub ? sub : undefined;
  } catch {
    return undefined;
  }
}

/** The random id that stands for this install before anyone is logged in: ~/.loopway/install-id, made on first use. */
export async function installId(dir: string): Promise<string> {
  const path = join(dir, "install-id");
  try {
    const id = (await readFile(path, "utf8")).trim();
    if (id) return id;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const id = randomUUID();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path, id + "\n", { mode: 0o600 });
  return id;
}

export function createMetrics(dir: string, env: NodeJS.ProcessEnv = process.env): Metrics {
  const apiKey = env.POSTHOG_API_KEY;
  const optedOut = (env.DO_NOT_TRACK && env.DO_NOT_TRACK !== "0") || env.LOOPWAY_TELEMETRY === "0";
  if (!apiKey || optedOut) return noopMetrics;
  let client: PostHog | undefined;
  return {
    // Sent right away, not batched: the CLI exits as soon as its command is done.
    async capture(event, properties) {
      try {
        // The host comes from `loadConfig`: config.json, else POSTHOG_HOST, else the API's `/api/ingest` proxy.
        const { api_key, posthog_host } = await loadConfig(dir, env);
        client ??= new PostHog(apiKey, { host: posthog_host });
        await client.captureImmediate({
          // The logged-in user, like the web side; the install until someone logs in.
          distinctId: tokenUserId(api_key) ?? (await installId(dir)),
          event,
          properties: { ...properties, product: "loopway", app: "loopway-cli", cli_version: CLI_VERSION },
        });
      } catch {
        // Offline or unwritable config dir: the command still has to work.
      }
    },
  };
}
