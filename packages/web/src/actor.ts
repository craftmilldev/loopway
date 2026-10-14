/**
 * An actor is whoever made a row: `user:<uuid>`, `bot:<uuid>` or `runner:<id>`. It is informational only (the
 * `created_by` columns) and has no tie to the users table. Access never reads it; that runs on org membership.
 */
export type ActorKind = "user" | "bot" | "runner";

export interface Actor {
  kind: ActorKind;
  id: string;
}

const KINDS: readonly string[] = ["user", "bot", "runner"];

export function formatActor(kind: ActorKind, id: string): string {
  return `${kind}:${id}`;
}

export const userActor = (id: string) => formatActor("user", id);
export const botActor = (id: string) => formatActor("bot", id);
export const runnerActor = (id: string) => formatActor("runner", id);

/** Undefined unless `value` is `<kind>:<id>` with a known kind and a non-empty id. */
export function parseActor(value: string): Actor | undefined {
  const i = value.indexOf(":");
  if (i < 1 || i === value.length - 1) return undefined;
  const kind = value.slice(0, i);
  if (!KINDS.includes(kind)) return undefined;
  return { kind: kind as ActorKind, id: value.slice(i + 1) };
}
