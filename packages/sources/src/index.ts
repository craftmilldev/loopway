import { github } from "./github.js";
import { granola } from "./granola.js";
import { linear } from "./linear.js";
import { loopway } from "./loopway.js";
import { SourceRegistry } from "./registry.js";
import { resend } from "./resend.js";
import { schedule } from "./schedule.js";
import type { SourceDeps } from "./types.js";
import { vercel } from "./vercel.js";

// Every source, one per line. A new source is a new file in this folder plus a line here.
export const createSources = (deps: SourceDeps) =>
  new SourceRegistry([
    github(deps),
    granola(deps),
    linear(deps),
    loopway(deps),
    resend(deps),
    schedule(deps),
    vercel(deps),
  ]);

export { SourceRegistry } from "./registry.js";
export type {
  SourceAdapter,
  SourceDeps,
  CloudEvent,
  IncomingWebhook,
  ReceiveResult,
  SampleContext,
  SampleDelivery,
  SecretOrigin,
} from "./types.js";
