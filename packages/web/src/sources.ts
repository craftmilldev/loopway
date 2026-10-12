import { createSources } from "@loopway/sources";
import { makeCloudEvent } from "./cloudevents.js";
import { newSecret, safeEqual, uuidv7 } from "./ids.js";

/** Every source, wired to the server's real ids, secrets and CloudEvent validation. */
export const sources = createSources({ newSecret, safeEqual, uuidv7, makeCloudEvent });
