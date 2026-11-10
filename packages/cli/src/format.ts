import type { Subject, Update } from "./source.js";

/** What the poller reports: a subject it just found, or something that happened to one it knows. */
export type LoopwayEvent = { type: "new"; subject: Subject } | { type: "update"; subject: string; update: Update };

const pad = (n: number) => String(n).padStart(2, "0");

/** Local time, `2026-11-10 14:02`. */
export function stamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatLine(event: LoopwayEvent): string {
  if (event.type === "new") {
    const s = event.subject;
    const kind = s.kind === "issue" ? "issue" : "pr";
    return `${stamp(s.createdAt)} new    ${s.key} ${kind} ${JSON.stringify(s.title)} by ${s.author}`;
  }
  const u = event.update;
  const what = u.detail ? `${u.kind} ${u.detail}` : u.kind;
  return `${stamp(u.at)} update ${event.subject} ${what} by ${u.actor}`;
}

export function formatJson(event: LoopwayEvent): string {
  if (event.type === "new") {
    const s = event.subject;
    return JSON.stringify({
      type: "new",
      time: s.createdAt,
      subject: s.key,
      kind: s.kind,
      title: s.title,
      author: s.author,
    });
  }
  const u = event.update;
  return JSON.stringify({
    type: "update",
    time: u.at,
    subject: event.subject,
    id: u.id,
    kind: u.kind,
    ...(u.detail ? { detail: u.detail } : {}),
    actor: u.actor,
  });
}
