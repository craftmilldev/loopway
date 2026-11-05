import { createSources } from "@loopway/sources";
import { makeCloudEvent } from "./cloudevents.js";
import { safeEqual, uuidv7 } from "./ids.js";

/** Every source, wired to the server's real ids, secret comparison and CloudEvent validation. */
export const sources = createSources({ safeEqual, uuidv7, makeCloudEvent });
