import { github } from "./github.js";
import { granola } from "./granola.js";
import { linear } from "./linear.js";
import { loopway } from "./loopway.js";
import { SourceRegistry } from "./registry.js";
import { vercel } from "./vercel.js";

// Every source, one per line. A new source is a new file in this folder plus a line here.
export const sources = new SourceRegistry([github, granola, linear, loopway, vercel]);

export { SourceRegistry } from "./registry.js";
export type { SourceAdapter, SourceRules, IncomingWebhook, ReceiveResult, SecretOrigin } from "./types.js";
export { makeCloudEvent, type CloudEvent } from "./cloudevents.js";
export { newSecret, safeEqual, uuidv7 } from "./ids.js";
