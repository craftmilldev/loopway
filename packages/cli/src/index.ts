#!/usr/bin/env node
import { ApiError } from "./client.js";
import { defaultConfigDir, NotLoggedInError } from "./config.js";
import { CancelledError, UsageError } from "./context.js";
import { red } from "./format.js";
import { createMetrics } from "./metrics.js";
import { createProgram } from "./program.js";
import { updateAfterOutdated } from "./update.js";

const configDir = defaultConfigDir();
const metrics = createMetrics(configDir);
const ctx = {
  configDir,
  env: process.env,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  out: (text: string) => process.stdout.write(text + "\n"),
  err: (text: string) => process.stderr.write(text + "\n"),
  metrics,
};
const program = createProgram(ctx);

try {
  await program.parseAsync();
} catch (err) {
  // Counted by kind, so the metrics show where commands stop.
  const kind = err instanceof ApiError ? `api:${err.code}` : err instanceof Error ? err.constructor.name : "unknown";
  await metrics.capture("cli_error", { kind });
  // The server turned this version away: update now and run the command again on the new one.
  if (err instanceof ApiError && err.code === "cli_outdated") {
    const notice = await updateAfterOutdated(ctx, err.message);
    if (notice) {
      console.error(red(notice));
      process.exit(1);
    }
  }
  if (err instanceof CancelledError) process.exit(130);
  if (err instanceof ApiError) {
    console.error(
      red(`error: ${err.message}`) + (err.code === "unauthorized" ? "\nRun `loopway login` to log in again." : ""),
    );
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else if (err instanceof UsageError || err instanceof NotLoggedInError) {
    console.error(red(`error: ${err.message}`));
  } else {
    console.error(err);
  }
  process.exit(1);
}
