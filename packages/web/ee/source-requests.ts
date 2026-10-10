import { z } from "zod";
import { uuidv7 } from "../src/ids.js";

/** The craftmill loopway inbox that requests for new source types go to: its webhook URL and inbox token. */
export interface SourceRequestTarget {
  url: string;
  token: string;
}

export const sourceRequestInput = z.object({ description: z.string().trim().min(1).max(500) });

/** Posts a `source.requested` message to the requests inbox. Returns whether the inbox took it. */
export async function sendSourceRequest(
  target: SourceRequestTarget,
  send: typeof fetch,
  request: { description: string; userId: string },
): Promise<boolean> {
  const r = await send(target.url, {
    method: "POST",
    headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      type: "source.requested",
      id: uuidv7(),
      // Only the user's id: it's enough to look them up, and keeps their name and email out of the message.
      data: { description: request.description, user: { id: request.userId } },
    }),
  }).catch((err: unknown) => {
    console.error("source request failed", err);
    return undefined;
  });
  if (!r?.ok) {
    if (r) console.error(`source request failed: ${r.status} ${await r.text()}`);
    return false;
  }
  return true;
}
