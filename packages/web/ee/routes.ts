import { Hono } from "hono";
import { ApiError, jsonBody, type Env } from "../src/http.js";
import type { Metrics } from "../src/metrics.js";
import { harnessRequestInput, sendRequest, sourceRequestInput, type SourceRequestTarget } from "./source-requests.js";

export interface EeOptions {
  /**
   * The craftmill loopway inbox that requests for new source types and harnesses go to: its webhook URL and inbox
   * token. Without it, `POST /sources/requests` and `POST /harnesses/requests` are a 404 and the web UI doesn't
   * offer requests.
   */
  sourceRequests?: SourceRequestTarget;
  /** Sends requests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** The authenticated routes under ee/. Mounted on the API after its auth middleware. */
export function eeRoutes(opts: EeOptions, metrics: Metrics) {
  const ee = new Hono<Env>();

  // Asks for a source type loopway doesn't have yet, by posting a message to the craftmill inbox for them.
  ee.post("/sources/requests", async (c) => {
    const target = opts.sourceRequests;
    if (!target) throw new ApiError(404, "not_found", "This deployment doesn't take source requests");
    const { description } = sourceRequestInput.parse(await jsonBody(c));
    const sent = await sendRequest(target, opts.fetch ?? fetch, {
      type: "source.requested",
      data: { description },
      userId: c.var.user.id,
    });
    if (!sent) throw new ApiError(502, "upstream", "Couldn't send the request. Try again later.");
    return c.json({ requested: true }, 202);
  });

  // Asks for a harness bots can't run in yet, by the URL of its product page.
  ee.post("/harnesses/requests", async (c) => {
    const target = opts.sourceRequests;
    if (!target) throw new ApiError(404, "not_found", "This deployment doesn't take harness requests");
    const parsed = harnessRequestInput.safeParse(await jsonBody(c));
    if (!parsed.success) {
      await metrics.capture("harness_request_rejected", c.var.user.id, { reason: "invalid_url" });
      throw new ApiError(400, "invalid_request", "Enter the harness's product page as an http(s) URL");
    }
    const sent = await sendRequest(target, opts.fetch ?? fetch, {
      type: "harness.requested",
      data: { url: parsed.data.url },
      userId: c.var.user.id,
    });
    if (!sent) {
      await metrics.capture("harness_request_failed", c.var.user.id, { reason: "upstream" });
      throw new ApiError(502, "upstream", "Couldn't send the request. Try again later.");
    }
    await metrics.capture("harness_requested", c.var.user.id);
    return c.json({ requested: true }, 202);
  });

  return ee;
}
