import { github, githubRules } from "./github.js";
import { granola } from "./granola.js";
import { linear } from "./linear.js";
import { loopway } from "./loopway.js";
import { SourceRegistry } from "./registry.js";
import type { SourceDeps, SourceRules } from "./types.js";
import { vercel } from "./vercel.js";

// Every source, one per line. A new source is a new file in this folder plus a line here.
export const createSources = (deps: SourceDeps) =>
  new SourceRegistry([github(deps), granola(deps), linear(deps), loopway(deps), vercel(deps)]);

/** Every source that defines rule helpers for bot rules (they need no deps). */
export const ruleSources: SourceRules[] = [githubRules];

export { SourceRegistry } from "./registry.js";
export type {
  SourceAdapter,
  SourceDeps,
  SourceRules,
  CloudEvent,
  IncomingWebhook,
  ReceiveResult,
  SecretOrigin,
} from "./types.js";
