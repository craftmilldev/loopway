import { z } from "zod";
import { uuidv7 } from "../src/ids.js";

/** The craftmill loopway inbox that requests for new source types go to: its webhook URL and inbox token. */
export interface SourceRequestTarget {
  url: string;
  token: string;
}

export const sourceRequestInput = z.object({ description: z.string().trim().min(1).max(500) });

/** A harness is asked for by the URL of its product page. */
export const harnessRequestInput = z.object({ url: z.url({ protocol: /^https?$/ }).max(500) });

/**
 * Posts a request message to the requests inbox: `source.requested` for a webhook source, `harness.requested` for
 * an agent harness. Returns whether the inbox took it.
 */
export async function sendRequest(
  target: SourceRequestTarget,
  send: typeof fetch,
  request: { type: "source.requested" | "harness.requested"; data: Record<string, string>; userId: string },
): Promise<boolean> {
  const r = await send(target.url, {
    method: "POST",
    headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      type: request.type,
      id: uuidv7(),
      // Only the user's id: it's enough to look them up, and keeps their name and email out of the message.
      data: { ...request.data, user: { id: request.userId } },
    }),
  }).catch((err: unknown) => {
    console.error(`${request.type} failed`, err);
    return undefined;
  });
  if (!r?.ok) {
    if (r) console.error(`${request.type} failed: ${r.status} ${await r.text()}`);
    return false;
  }
  return true;
}
