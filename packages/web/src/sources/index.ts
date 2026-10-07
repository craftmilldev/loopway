import { github } from "./github.js";
import { granola } from "./granola.js";
import type { SourceAdapter } from "./types.js";
import { vercel } from "./vercel.js";

export const sources: Record<string, SourceAdapter<any>> = {
  [github.type]: github,
  [granola.type]: granola,
  [vercel.type]: vercel,
};

export function getSource(type: string): SourceAdapter<unknown> | undefined {
  return sources[type];
}

export type { SourceAdapter, IncomingWebhook, ReceiveResult } from "./types.js";
