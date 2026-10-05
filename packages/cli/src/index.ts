#!/usr/bin/env node
import { ApiError } from "./client.js";
import { defaultConfigDir, NotLoggedInError } from "./config.js";
import { CancelledError, UsageError } from "./context.js";
import { red } from "./format.js";
import { createProgram } from "./program.js";

const program = createProgram({
  configDir: defaultConfigDir(),
  env: process.env,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  out: (text) => process.stdout.write(text + "\n"),
});

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof CancelledError) process.exit(130);
  if (err instanceof ApiError) {
    console.error(red(`error: ${err.message}`) + (err.code === "unauthorized" ? "\nRun `loopway login`." : ""));
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else if (err instanceof UsageError || err instanceof NotLoggedInError) {
    console.error(red(`error: ${err.message}`));
  } else {
    console.error(err);
  }
  process.exit(1);
}
