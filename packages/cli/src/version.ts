import { createRequire } from "node:module";

/** This CLI's version, from its package.json (one level up from both src/ and dist/). */
export const CLI_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/** Sent on every API request so the server can count versions and turn away ones it no longer supports. */
export const VERSION_HEADER = "x-loopway-cli-version";
