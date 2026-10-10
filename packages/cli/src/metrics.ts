import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PostHog } from "posthog-node";

/** Product metrics. Sends nothing unless POSTHOG_API_KEY is set, or if DO_NOT_TRACK / LOOPWAY_TELEMETRY=0 is. */
export interface Metrics {
  /** Records one event for this install. Never throws: metrics must not break a command. */
  capture(event: string, properties?: Record<string, unknown>): Promise<void>;
}

export const noopMetrics: Metrics = { capture: async () => {} };

/** The random id that stands for this install in events: ~/.loopway/install-id, made on first use. */
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
  const client = new PostHog(apiKey, { host: env.POSTHOG_HOST || undefined });
  return {
    // Sent right away, not batched: the CLI exits as soon as its command is done.
    async capture(event, properties) {
      try {
        await client.captureImmediate({
          distinctId: await installId(dir),
          event,
          properties: { ...properties, app: "cli" },
        });
      } catch {
        // Offline or unwritable config dir: the command still has to work.
      }
    },
  };
}
