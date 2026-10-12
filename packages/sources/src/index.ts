import { github } from "./github.js";
import { granola } from "./granola.js";
import { linear } from "./linear.js";
import { loopway } from "./loopway.js";
import { SourceRegistry } from "./registry.js";
import type { SourceDeps } from "./types.js";
import { vercel } from "./vercel.js";

// Every source, one per line. A new source is a new file in this folder plus a line here.
export const createSources = (deps: SourceDeps) =>
  new SourceRegistry([github(deps), granola(deps), linear(deps), loopway(deps), vercel(deps)]);

/** Deps for callers that only read what a source declares (e.g. its rule helpers); using any of them throws. */
export const NO_DEPS: SourceDeps = {
  newSecret: unavailable,
  uuidv7: unavailable,
  safeEqual: unavailable,
  makeCloudEvent: unavailable,
};

function unavailable(): never {
  throw new Error("These sources were created without deps; they can't receive webhooks or make secrets.");
}

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
