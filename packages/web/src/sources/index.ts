import { github } from "./github.js";
import { SourceRegistry } from "./registry.js";
import { vercel } from "./vercel.js";

// Every source, one per line. A new source is a new file in this folder plus a line here.
export const sources = new SourceRegistry([
  github,
  vercel,
]);

export { SourceRegistry } from "./registry.js";
export type { SourceAdapter, IncomingWebhook, ReceiveResult, SecretOrigin } from "./types.js";
