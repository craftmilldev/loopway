import { useEffect, useState } from "react";
import { botState, type BotState } from "./bot-state.js";
import type { Inbox } from "./dashboard.js";
import { BAR_DAYS, DeliveryBars } from "./delivery-bars.js";
import { DashLayout } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

const RANGES = [
  { key: "24h", label: "24 h", days: 1 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
];

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const word = (n: number) => WORDS[n] ?? String(n);
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** The state as a lowercase badge. */
export function StateBadge({ state }: { state: BotState }) {
  return <span className={"state state-" + state}>{state}</span>;
}

function headline(bots: number, working: number, open: number) {
  if (!bots) return "No bots yet.";
  if (!open) return "Nothing is open right now.";
  if (!working) return `No bots at work. ${plural(open, "thread")} open.`;
  return `${word(working)} ${working === 1 ? "bot" : "bots"} at work on ${plural(open, "thread")}.`;
}

export function Overview() {
  const me = lw.useMe();
  const ready = !!me;
  const bots = lw.useList<lw.Bot>("/bots", ready);
  const runners = lw.useList<lw.Runner>("/runners", ready);
  const inboxes = lw.useList<Inbox>("/inboxes", ready);
  const [range, setRange] = useState(RANGES[1]!);
  const [threads, setThreads] = useState<Record<string, lw.Thread[]>>({});
  const [activity, setActivity] = useState<Record<string, lw.BotActivity> | null>(null);

  // Each bot's active threads. One request per bot.
  useEffect(() => {
    for (const b of bots.data ?? []) {
      void lw.api(`/bots/${b.id}/threads?status=active`).then(async (r) => {
        if (!r.ok) return track("overview_load_failed", { resource: "threads", status: r.status });
        const data = ((await r.json()) as { data: lw.Thread[] }).data;
        setThreads((t) => ({ ...t, [b.id]: data }));
      });
    }
  }, [bots.data]);

  // Every bot's deliveries in one call, as many days as the bars and the longest range need.
  useEffect(() => {
    if (!ready) return;
    void lw.api("/bots/activity?days=" + Math.max(BAR_DAYS, ...RANGES.map((r) => r.days))).then(async (r) => {
      if (!r.ok) return track("overview_load_failed", { resource: "activity", status: r.status });
      const data = ((await r.json()) as { data: lw.BotActivity[] }).data;
      setActivity(Object.fromEntries(data.map((a) => [a.bot_id, a])));
    });
  }, [ready]);

  // The ranges are whole UTC days, so "24 h" is today.
  const delivered = activity
    ? Object.values(activity).reduce((n, a) => n + a.days.slice(-range.days).reduce((m, d) => m + d.delivered, 0), 0)
    : null;

  const loaded = bots.data && runners.data && inboxes.data && bots.data.every((b) => threads[b.id]);
  const hasBots = (bots.data?.length ?? 0) > 0;
  const hasRunners = (runners.data?.length ?? 0) > 0;
  useEffect(() => {
    if (loaded) track("overview_viewed", { has_bots: hasBots, has_runners: hasRunners });
  }, [loaded, hasBots, hasRunners]);

  const pick = (r: (typeof RANGES)[number]) => {
    track("overview_range_changed", { range: r.key });
    setRange(r);
  };

  const states = new Map<string, BotState>();
  let open = 0;
  let waitingMessages = 0;
  const waitingBy = new Map<string, number>();
  for (const b of bots.data ?? []) {
    const ts = threads[b.id];
    if (!ts || !runners.data) continue;
    states.set(b.id, botState(ts, runners.data));
    open += ts.length;
    const w = ts.reduce((n, t) => n + t.waiting.length, 0);
    waitingBy.set(b.id, w);
    waitingMessages += w;
  }
  const working = [...states.values()].filter((s) => s === "working").length;
  const inflightThreads = Object.values(threads)
    .flat()
    .filter((t) => t.inflight.length).length;
  const online = runners.data?.filter((r) => r.leased_until).length ?? 0;
  const inboxName = (id: string) => inboxes.data?.find((i) => i.id === id)?.name ?? id;
  const botName = (id: string) => bots.data?.find((b) => b.id === id)?.name ?? id;

  return (
    <DashLayout title="Dashboard · loopway" me={me}>
      <section className="ov-top">
        <div>
          <span className="lbl">Overview</span>
          <h1 className="ov-headline">{loaded ? headline(bots.data!.length, working, open) : " "}</h1>
        </div>
        <div className="range" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              className={r === range ? "on" : undefined}
              aria-pressed={r === range}
              onClick={() => pick(r)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </section>

      {bots.data?.length === 0 && (
        <p className="ov-empty">
          Nothing is running yet. <a href="/dashboard/bots/new">Create your first bot</a> to start.
        </p>
      )}

      <section className="figures" aria-label="Figures">
        <div className="figure">
          <span className="lbl">Open threads</span>
          <span className="figure-n">{loaded ? open : "…"}</span>
          <span className="figure-note">
            {loaded ? `${inflightThreads} working, ${open - inflightThreads} waiting` : ""}
          </span>
        </div>
        <div className="figure">
          <span className="lbl">Messages delivered</span>
          <span className="figure-n">{delivered ?? "…"}</span>
          <span className="figure-note">in the last {range.label}</span>
        </div>
        <div className="figure">
          <span className="lbl">Runners online</span>
          <span className="figure-n">
            {runners.data ? online : "…"}
            {runners.data && <span className="figure-of"> of {runners.data.length}</span>}
          </span>
          <span className="figure-note">{waitingMessages ? plural(waitingMessages, "message") + " waiting" : ""}</span>
        </div>
      </section>

      <section id="bots" className="ov-section">
        <div className="ov-section-head">
          <h2>Who is doing what</h2>
          <a className="btn btn-md btn-quiet" href="/dashboard/bots/new">
            New bot
          </a>
        </div>
        <div className="scroll">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Bot</th>
                <th scope="col">State</th>
                <th scope="col">Reads</th>
                <th scope="col" className="num">
                  Open
                </th>
                <th scope="col" className="num">
                  Waiting
                </th>
                <th scope="col">Deliveries, {BAR_DAYS} days</th>
                <th scope="col" className="num">
                  Last delivery
                </th>
              </tr>
            </thead>
            <tbody>
              {bots.data?.map((b) => {
                const state = states.get(b.id);
                return (
                  <tr key={b.id}>
                    <td>
                      <a className="bot-link" href={"/dashboard/bots/" + b.id}>
                        {b.name}
                      </a>
                      <div className="lbl small">{b.model}</div>
                    </td>
                    <td>{state ? <StateBadge state={state} /> : "…"}</td>
                    <td className="mono">{b.inbox_ids.map(inboxName).join(", ")}</td>
                    <td className="num">{threads[b.id]?.length ?? "…"}</td>
                    <td className="num">{waitingBy.get(b.id) ?? "…"}</td>
                    <td>
                      <DeliveryBars activity={activity?.[b.id]} days={BAR_DAYS} />
                    </td>
                    <td className={"num" + (activity?.[b.id]?.last_delivery_at ? "" : " muted")}>
                      {activity ? lw.ago(activity[b.id]?.last_delivery_at ?? null) : "…"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ov-split">
        <div className="ov-main">
          <span className="lbl">Today on the threads</span>
          <h2>What the bots did</h2>
          <p className="muted">Nothing to show yet. What the bots do will be listed here.</p>
        </div>
        <div id="runners" className="ov-side">
          <span className="lbl">Runners</span>
          <h2>The machines</h2>
          {runners.data?.map((r) => (
            <div key={r.id} className="runner">
              <div className="runner-row">
                <span className="mono">{r.name}</span>
                <span className={"state " + (r.leased_until ? "state-working" : "state-stranded")}>
                  {r.leased_until ? "online" : "offline"}
                </span>
              </div>
              <div className="runner-note">
                {r.bots.length ? "Holds " + r.bots.map((b) => botName(b.id)).join(", ") : "Holds no bots"} ·{" "}
                {plural(r.threads, "thread")} · seen {lw.when(r.last_seen_at)}
              </div>
            </div>
          ))}
          {runners.data?.length === 0 && <p className="muted">No runners yet.</p>}
          <div className="add-runner">
            <span className="lbl">Add a runner</span>
            <code>$ loopway bots run</code>
          </div>
        </div>
      </section>
    </DashLayout>
  );
}
