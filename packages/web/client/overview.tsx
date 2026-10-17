import { useEffect, useRef, useState } from "react";
import { botState, countThreads, sumCounts, type BotState, type ThreadCounts } from "./bot-state.js";
import type { Inbox } from "./shared.js";
import { deliveredIn } from "./activity.js";
import { BAR_DAYS, DeliveryBars } from "./delivery-bars.js";
import { LevelPie } from "./level-pie.js";
import { DashLayout, MembersHint } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";
import { Updated } from "./updated.js";

const RANGES = [
  { key: "24h", label: "24 h", days: 1 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
];

const SUMMARY_RUNNERS = 4;

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

const EVENTS_PAGE = 10;

/** "What the bots did": the thread events ten at a time, newest first, with Newer and Older to move between pages. */
export function ThreadEventsFeed({ ready }: { ready: boolean }) {
  // The cursors of the pages walked through, the last being the one shown; null is the newest page.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState<{ data: lw.ThreadEvent[]; next: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const cursor = cursors[cursors.length - 1]!;
  // The page being shown, for the requests that finish after the reader has moved on.
  const current = useRef(cursor);
  current.current = cursor;

  const fetchPage = async (at: string | null) => {
    const r = await lw.api(lw.inOrg(`/events?limit=${EVENTS_PAGE}` + (at ? "&before=" + at : "")));
    if (!r.ok) {
      track("overview_load_failed", { resource: "events", status: r.status });
      return null;
    }
    return (await r.json()) as { data: lw.ThreadEvent[]; next: string | null };
  };

  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    void fetchPage(cursor).then((body) => {
      if (current.current !== cursor) return;
      setLoading(false);
      if (body) setPage(body);
    });
  }, [ready, cursor]); // eslint-disable-line react-hooks/exhaustive-deps

  // A refresh reloads the page being shown, and keeps it when the request fails or nothing changed.
  lw.usePoll(async () => {
    const at = current.current;
    const body = await fetchPage(at);
    if (!body) return false;
    if (current.current === at) setPage((p) => (lw.same(p, body) ? p : body));
    return true;
  }, ready);

  const older = () => {
    if (!page?.next) return;
    track("overview_events_page_clicked", { direction: "older", page: cursors.length + 1 });
    setCursors([...cursors, page.next]);
  };
  const newer = () => {
    track("overview_events_page_clicked", { direction: "newer", page: cursors.length - 1 });
    setCursors(cursors.slice(0, -1));
  };

  const events = page?.data ?? [];
  const midnight = new Date(new Date().setHours(0, 0, 0, 0)).getTime();

  return (
    <>
      {page && events.length === 0 && (
        <p className="muted">Nothing to show yet. What the bots do will be listed here.</p>
      )}
      <ul className="feed">
        {events.map((e) => {
          const at = new Date(e.at);
          return (
            <li key={e.id}>
              <time className="mono" dateTime={e.at} title={at.toLocaleString()}>
                {at.getTime() < midnight
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
      {(cursors.length > 1 || page?.next) && (
        <div className="feed-pager">
          {cursors.length > 1 && (
            <button type="button" className="btn btn-md btn-quiet" disabled={loading} onClick={newer}>
              Newer
            </button>
          )}{" "}
          {page?.next && (
            <button type="button" className="btn btn-md btn-quiet" disabled={loading} onClick={older}>
              Older
            </button>
          )}
        </div>
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
  const countBy = new Map<string, ThreadCounts>();
  for (const b of bots.data ?? []) {
    const ts = threads[b.id];
    if (!ts || !runners.data) continue;
    states.set(b.id, botState(ts, runners.data));
    countBy.set(b.id, countThreads(ts));
  }
  const working = [...states.values()].filter((s) => s === "working").length;
  const { open, working: workingThreads, quiet, waiting: waitingMessages } = sumCounts([...countBy.values()]);
  const online = runners.data?.filter((r) => r.leased_until).length ?? 0;
  const inboxName = (id: string) => inboxes.data?.find((i) => i.id === id)?.name ?? id;
  // Offline runners first: they are the ones that need a look.
  const summary = [...(runners.data ?? [])]
    .sort((a, b) => +!!a.leased_until - +!!b.leased_until)
    .slice(0, SUMMARY_RUNNERS);
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
          <span className="figure-note">{loaded ? `${workingThreads} working · ${quiet} quiet` : ""}</span>
        </div>
        <div className="figure">
          <span className="lbl">Messages waiting</span>
          <span className="figure-n">{loaded ? waitingMessages : "…"}</span>
          <span className="figure-note">queued on open threads</span>
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
                  Open threads
                </th>
                <th scope="col" className="num">
                  Messages waiting
                </th>
                <th scope="col">Deliveries, {BAR_DAYS} days</th>
                <th scope="col">Levels</th>
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
                    <td className="num">{countBy.get(b.id)?.open ?? "…"}</td>
                    <td className="num">{countBy.get(b.id)?.waiting ?? "…"}</td>
                    <td>
                      <DeliveryBars activity={activity?.[b.id]} days={BAR_DAYS} />
                    </td>
                    <td>
                      <LevelPie levels={activity?.[b.id]?.levels} />
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
          <span className="lbl">On the threads</span>
          <h2>What the bots did</h2>
          <ThreadEventsFeed ready={ready} />
        </div>
        <div className="ov-side">
          <span className="lbl">Runners</span>
          <h2>The machines</h2>
          {summary.map((r) => (
            <div key={r.id} className="runner">
              <div className="runner-row">
                <span className="mono">{r.name}</span>
                <span className={"state " + (r.leased_until ? "state-working" : "state-stranded")}>
                  {r.leased_until ? "online" : "offline"}
                </span>
              </div>
              <div className="runner-note">
                {r.bots.length ? "Holds " + r.bots.map((b) => botName(b.id)).join(", ") : "Holds no bots"} ·{" "}
                {plural(r.threads, "thread")} · seen {lw.ago(r.last_seen_at)}
              </div>
            </div>
          ))}
          {runners.data?.length === 0 && <p className="muted">No runners yet.</p>}
          {runners.data && (
            <a className="btn btn-md btn-quiet" href={lw.orgBase() + "/runners"}>
              All runners{runners.data.length ? ` · ${online} of ${runners.data.length} online` : ""}
            </a>
          )}
        </div>
      </section>
    </DashLayout>
  );
}
