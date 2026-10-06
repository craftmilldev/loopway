import { github } from "./github.js";
import { granola } from "./granola.js";
import type { SourceAdapter } from "./types.js";

export const sources: Record<string, SourceAdapter<any>> = {
  [github.type]: github,
  [granola.type]: granola,
};

export function getSource(type: string): SourceAdapter<unknown> | undefined {
  return sources[type];
}

export type { SourceAdapter, IncomingWebhook, ReceiveResult } from "./types.js";
