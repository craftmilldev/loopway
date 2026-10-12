import type { CloudEvent } from "@loopway/sources";

export type { CloudEvent };

const EXT_NAME = /^[a-z0-9]{1,20}$/;

/** Drops undefined optionals and validates the required attributes. */
export function makeCloudEvent(e: CloudEvent): CloudEvent {
  for (const k of ["id", "source", "type"] as const) {
    if (typeof e[k] !== "string" || e[k] === "") throw new Error(`CloudEvent.${k} is required`);
  }
  const out: CloudEvent = { specversion: "1.0", id: e.id, source: e.source, type: e.type };
  for (const [k, v] of Object.entries(e)) {
    if (v === undefined || v === null || k in out) continue;
    if (!EXT_NAME.test(k)) throw new Error(`Invalid CloudEvents attribute name: ${k}`);
    out[k] = v;
  }
  return out;
}
