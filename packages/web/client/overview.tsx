import { useEffect, useRef, useState } from "react";
import { botState, type BotState } from "./bot-state.js";
import type { Inbox } from "./shared.js";
import { deliveredIn } from "./activity.js";
import { BAR_DAYS, DeliveryBars } from "./delivery-bars.js";
import { DashLayout, MembersHint } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";
import { Updated } from "./updated.js";

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

const EVENT_TEXT: Record<lw.ThreadEvent["kind"], string> = {
  created: "was given a thread",
  started: "started a thread",
  ended: "ended a thread",
  interrupted: "was interrupted",
  limited: "hit its usage limit",
  limit_cleared: "is clear of its usage limit",
};

const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime();

/** "What the bots did": today's thread events, newest first, and a control for the days before. */
export function ThreadEventsFeed({ ready }: { ready: boolean }) {
  const [events, setEvents] = useState<lw.ThreadEvent[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [earlier, setEarlier] = useState(false);
  const [loading, setLoading] = useState(false);
  // The list as last set, for the requests that finish after a render they started in.
  const listed = useRef<lw.ThreadEvent[] | null>(null);

  const load = async (before: string | null) => {
    setLoading(true);
    const r = await lw.api(lw.inOrg("/events" + (before ? "?before=" + before : "")));
    setLoading(false);
    if (!r.ok) return track("overview_load_failed", { resource: "events", status: r.status });
    const body = (await r.json()) as { data: lw.ThreadEvent[]; next: string | null };
    listed.current = [...(listed.current ?? []), ...body.data];
    setEvents(listed.current);
    setNext(body.next);
  };

  useEffect(() => {
    if (ready) void load(null);
  }, [ready]);

  // A refresh reads the newest page and adds only the events it hasn't got, so "Show earlier" and its place stay put.
  // If the page shares nothing with the list, there may be events in between that it can't reach, so it starts over.
  lw.usePoll(async () => {
    const r = await lw.api(lw.inOrg("/events"));
    if (!r.ok) {
      track("overview_load_failed", { resource: "events", status: r.status });
      return false;
    }
    const body = (await r.json()) as { data: lw.ThreadEvent[]; next: string | null };
    // Merges into the list as it is now, not as it was when this request started: a page may have loaded since.
    const merged = lw.mergeNewest(listed.current, body.data, !!body.next);
    if (merged.items !== listed.current) {
      listed.current = merged.items;
      setEvents(merged.items);
    }
    if (merged.replaced) setNext(body.next);
    return true;
  }, ready);

  // A full page of today's events may not be all of them: keep reading until the page reaches back past midnight.
  useEffect(() => {
    const last = events?.[events.length - 1];
    if (next && last && !earlier && !loading && new Date(last.at).getTime() >= startOfToday()) void load(next);
  }, [events, next, earlier, loading]);

  const midnight = startOfToday();
  const shown = (events ?? []).filter((e) => earlier || new Date(e.at).getTime() >= midnight);
  const hasEarlier = earlier ? !!next : !!events && (shown.length < events.length || !!next);

  const showEarlier = () => {
    track("overview_events_earlier_clicked", { loaded: events?.length ?? 0 });
    setEarlier(true);
    if (next) void load(next);
  };

  return (
    <>
      {events && shown.length === 0 && (
        <p className="muted">Nothing to show yet. What the bots do will be listed here.</p>
      )}
      <ul className="feed">
        {shown.map((e) => {
          const at = new Date(e.at);
          return (
            <li key={e.id}>
              <time className="mono" dateTime={e.at} title={at.toLocaleString()}>
                {earlier && at.getTime() < midnight
                  ? at.toLocaleDateString([], { month: "short", day: "numeric" }) + " "
                  : ""}
                {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </time>{" "}
              <a className="bot-link" href={lw.orgBase() + "/bots/" + e.bot_id}>
                {e.bot_name}
              </a>{" "}
              {EVENT_TEXT[e.kind]}:{" "}
              <a href={`${lw.orgBase()}/bots/${e.bot_id}/threads/${e.thread_id}`}>
                {e.title ?? (e.subjects.join(", ") || "a thread")}
              </a>
            </li>
          );
        })}
      </ul>
      {hasEarlier && (
        <button type="button" className="btn btn-md btn-quiet" disabled={loading} onClick={showEarlier}>
          Show earlier
        </button>
      )}
    </>
  );
}

export function Overview() {
  const me = lw.useMe();
  const ready = !!me;
  const bots = lw.useList<lw.Bot>(lw.inOrg("/bots"), ready);
  const runners = lw.useList<lw.Runner>(lw.inOrg("/runners"), ready);
  const inboxes = lw.useList<Inbox>(lw.inOrg("/inboxes"), ready);
  lw.usePoll(bots.reload, ready);
  lw.usePoll(runners.reload, ready);
  lw.usePoll(inboxes.reload, ready);
  const [range, setRange] = useState(RANGES[1]!);
  const [threads, setThreads] = useState<Record<string, lw.Thread[]>>({});
  const [activity, setActivity] = useState<Record<string, lw.BotActivity> | null>(null);

  // Each bot's active threads. One request per bot. A refresh keeps what it has when a request fails.
  const loadThreads = async () => {
    let ok = true;
    await Promise.all(
      (bots.data ?? []).map(async (b) => {
        const r = await lw.api(`/bots/${b.id}/threads?status=active`);
        if (!r.ok) {
          ok = false;
          return track("overview_load_failed", { resource: "threads", status: r.status });
        }
        const data = ((await r.json()) as { data: lw.Thread[] }).data;
        setThreads((t) => (lw.same(t[b.id], data) ? t : { ...t, [b.id]: data }));
      }),
    );
    return ok;
  };
  useEffect(() => {
    void loadThreads();
  }, [bots.data]); // eslint-disable-line react-hooks/exhaustive-deps
  lw.usePoll(loadThreads, ready && !!bots.data);

  // Every bot's deliveries in one call, as many days as the bars and the longest range need.
  const loadActivity = async () => {
    const r = await lw.api(lw.inOrg("/bots/activity?days=" + Math.max(BAR_DAYS, ...RANGES.map((r) => r.days))));
    if (!r.ok) {
      track("overview_load_failed", { resource: "activity", status: r.status });
      return false;
    }
    const data = ((await r.json()) as { data: lw.BotActivity[] }).data;
    const next = Object.fromEntries(data.map((a) => [a.bot_id, a]));
    setActivity((a) => (lw.same(a, next) ? a : next));
    return true;
  };
  useEffect(() => {
    if (ready) void loadActivity();
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  lw.usePoll(loadActivity, ready);

  // The ranges are whole UTC days, so "24 h" is today.
  const delivered = activity ? deliveredIn(Object.values(activity), range.days) : null;

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
          <Updated />
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
          Nothing is running yet. <a href={lw.orgBase() + "/bots/new"}>Create your first bot</a> to start.
          <MembersHint />
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
          <a className="btn btn-md btn-quiet" href={lw.orgBase() + "/bots/new"}>
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
                      <a className="bot-link" href={lw.orgBase() + "/bots/" + b.id}>
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
          <ThreadEventsFeed ready={ready} />
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
                {plural(r.threads, "thread")} · {r.org} · seen {lw.when(r.last_seen_at)}
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
