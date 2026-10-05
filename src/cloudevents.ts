/** CloudEvents v1.0, structured-mode JSON representation. https://github.com/cloudevents/spec */
export interface CloudEvent {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  subject?: string;
  time?: string;
  datacontenttype?: string;
  dataschema?: string;
  data?: unknown;
  /** Extension attributes: lowercase a-z0-9, max 20 chars. */
  [extension: string]: unknown;
}

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
