import { useEffect, useState } from "react";
import type { Inbox } from "./shared.js";
import { BAR_DAYS, DeliveryBars } from "./delivery-bars.js";
import { MembersHint } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;

/** What a schedule inbox sends and when, in place of the events a webhook inbox takes. */
export function scheduleText(schedule: NonNullable<NonNullable<Inbox["config"]>["schedule"]>, messages: number) {
  const when = schedule.every === "hour" ? "every hour" : `daily at ${String(schedule.hour).padStart(2, "0")}:00 UTC`;
  return `${when} · ${plural(messages, "message type")}`;
}

/** What the inbox keeps, in words: "every event" or "3 event types". */
export function eventsText(events: string[] | undefined) {
  return !events || events.includes("*") ? "every event" : plural(events.length, "event type");
}

/**
 * The advanced part of the bots page: what each inbox receives, who reads it, and a way to its page. Inboxes are made
 * for the user when they connect a source for a bot, so this stays folded away until they want it.
 */
export function InboxesSection({
  inboxes,
  bots,
  orgs,
}: {
  inboxes: Inbox[];
  bots: lw.Bot[];
  orgs: lw.Org[] | null;
}) {
  const sources = lw.useSources();
  const [activity, setActivity] = useState<Record<string, lw.InboxActivity> | null>(null);
  const [open, setOpen] = useState(false);

  // Every inbox's messages, in one call, once the section is opened.
  const loadActivity = async () => {
    const r = await lw.api(lw.inOrg("/inboxes/activity?days=" + BAR_DAYS));
    if (!r.ok) {
      track("inboxes_load_failed", { resource: "activity", status: r.status });
      return false;
    }
    const data = ((await r.json()) as { data: lw.InboxActivity[] }).data;
    const next = Object.fromEntries(data.map((a) => [a.inbox_id, a]));
    setActivity((a) => (lw.same(a, next) ? a : next));
    return true;
  };
  useEffect(() => {
    if (open) void loadActivity();
  }, [open]);
  lw.usePoll(loadActivity, open);

  const rows = inboxes;
  const needsSecret = (i: Inbox) =>
    !i.config?.secret_set && sources?.data.find((s) => s.type === i.source_type)?.secret.from !== "none";
  const missing = rows.filter(needsSecret).length;

  const label = (type: string) => sources?.data.find((s) => s.type === type)?.label ?? type;

  return (
    <details
      className="inboxes-section"
      onToggle={(e) => {
        const now = e.currentTarget.open;
        setOpen(now);
        if (now) track("inboxes_viewed", { count: rows.length, missing_secret: missing });
      }}
    >
      <summary>
        Inboxes · {rows.length}
        {missing > 0 && <span className="why missing"> · {missing} need a secret</span>}
      </summary>
      <p className="muted">
        Each inbox listens to one source's webhook, checks its signature, and keeps what arrives in order. They are made
        when you connect a source for a bot; open one to change its events or secret.
      </p>
      {rows.length === 0 && (
        <p className="ov-empty">
          No inboxes yet. <a href={lw.orgBase() + "/bots/new"}>Create a bot</a> to connect a source.
          <MembersHint />
        </p>
      )}
      {rows.length > 0 && (
        <div className="scroll">
          <table className="ledger inboxes-ledger">
            <thead>
              <tr>
                <th scope="col">Inbox</th>
                <th scope="col">Source</th>
                <th scope="col">Read by</th>
                <th scope="col">Messages, {BAR_DAYS} days</th>
                <th scope="col" className="num">
                  Last message
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => {
                const a = activity?.[i.id];
                const readers = bots.filter((b) => b.inbox_ids.includes(i.id));
                return (
                  <tr key={i.id}>
                    <td>
                      <a className="bot-link" href={lw.orgBase() + "/inboxes/" + i.id}>
                        {i.name}
                      </a>
                      <div className="lbl small">
                        {lw.orgLabel(orgs, rows, i.org_id) ? lw.orgLabel(orgs, rows, i.org_id) + " · " : ""}
                        {i.config?.schedule
                          ? scheduleText(i.config.schedule, i.config.messages?.length ?? 0)
                          : eventsText(i.config?.events)}
                        {a ? " · " + plural(a.messages, "message") : ""}
                      </div>
                      {needsSecret(i) && <div className="why missing">needs its secret</div>}
                    </td>
                    <td className="mono">{label(i.source_type)}</td>
                    <td>
                      {readers?.length ? (
                        readers.map((b, n) => (
                          <span key={b.id}>
                            {n > 0 && ", "}
                            <a href={lw.orgBase() + "/bots/" + b.id}>{b.name}</a>
                          </span>
                        ))
                      ) : (
                        <span className="muted">{readers ? "no bot yet" : "…"}</span>
                      )}
                    </td>
                    <td>
                      <DeliveryBars activity={lw.barDays(a)} days={BAR_DAYS} />
                    </td>
                    <td className={"num" + (a?.last_message_at ? "" : " muted")}>
                      {a ? lw.ago(a.last_message_at) : "…"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
