import { Hono } from "hono";
import { ApiError, jsonBody, type Env } from "../src/http.js";
import { sendSourceRequest, sourceRequestInput, type SourceRequestTarget } from "./source-requests.js";

export interface EeOptions {
  /**
   * The craftmill loopway inbox that requests for new source types go to: its webhook URL and inbox
   * token. Without it, `POST /sources/requests` is a 404 and the web UI doesn't offer requests.
   */
  sourceRequests?: SourceRequestTarget;
  /** Sends source requests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** The authenticated routes under ee/. Mounted on the API after its auth middleware. */
export function eeRoutes(opts: EeOptions) {
  const ee = new Hono<Env>();

  // Asks for a source type loopway doesn't have yet, by posting a message to the craftmill inbox for them.
  ee.post("/sources/requests", async (c) => {
    const target = opts.sourceRequests;
    if (!target) throw new ApiError(404, "not_found", "This deployment doesn't take source requests");
    const { description } = sourceRequestInput.parse(await jsonBody(c));
    if (!(await sendSourceRequest(target, opts.fetch ?? fetch, { description, userId: c.var.user.id }))) {
      throw new ApiError(502, "upstream", "Couldn't send the request. Try again later.");
    }
    return c.json({ requested: true }, 202);
  });

  return ee;
}
