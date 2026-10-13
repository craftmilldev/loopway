import { useEffect, useState } from "react";
import { botState, filterOf, stateReason, type BotFilter } from "./bot-state.js";
import type { Inbox } from "./dashboard.js";
import { DashLayout } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";
import { StateBadge } from "./overview.js";

const FILTERS: { key: BotFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "stopped", label: "Stopped" },
  { key: "working", label: "Working" },
  { key: "idle", label: "Idle" },
];

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;

export function Bots() {
  const me = lw.useMe();
  const ready = !!me;
  const bots = lw.useList<lw.Bot>("/bots", ready);
  const runners = lw.useList<lw.Runner>("/runners", ready);
  const inboxes = lw.useList<Inbox>("/inboxes", ready);
  const [threads, setThreads] = useState<Record<string, lw.Thread[]>>({});
  const [filter, setFilter] = useState<BotFilter>("all");
  const [find, setFind] = useState("");

  // Each bot's active threads. One request per bot.
  useEffect(() => {
    for (const b of bots.data ?? []) {
      void lw.api(`/bots/${b.id}/threads?status=active`).then(async (r) => {
        if (!r.ok) return track("bots_load_failed", { resource: "threads", status: r.status });
        const data = ((await r.json()) as { data: lw.Thread[] }).data;
        setThreads((t) => ({ ...t, [b.id]: data }));
      });
    }
  }, [bots.data]);

  const loaded = !!(bots.data && runners.data && inboxes.data && bots.data.every((b) => threads[b.id]));
  const total = bots.data?.length ?? 0;
  useEffect(() => {
    if (loaded) track("bots_viewed", { count: total, has_bots: total > 0 });
  }, [loaded, total]);

  const inboxName = (id: string) => inboxes.data?.find((i) => i.id === id)?.name ?? id;
  const rows = loaded
    ? bots.data!.map((b) => {
        const ts = threads[b.id]!;
        const state = botState(ts, runners.data!);
        return {
          bot: b,
          state,
          reason: stateReason(state, ts),
          inboxes: b.inbox_ids.map(inboxName),
          runner: runners.data!.find((r) => r.id === b.runner_id)?.name ?? null,
          open: ts.length,
          waiting: ts.reduce((n, t) => n + t.waiting.length, 0),
        };
      })
    : [];
  const counts: Record<BotFilter, number> = { all: rows.length, stopped: 0, working: 0, idle: 0 };
  for (const r of rows) counts[filterOf(r.state)]++;
  const needle = find.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (filter === "all" || filterOf(r.state) === filter) &&
      (!needle || [r.bot.name, ...r.inboxes].some((n) => n.toLowerCase().includes(needle))),
  );

  const pick = (key: BotFilter) => {
    track("bots_filter_changed", { filter: key });
    setFilter(key);
  };
  // A filter or find that leaves nothing is where this page gives up on the user, so that's recorded.
  useEffect(() => {
    if (loaded && total && !shown.length) track("bots_none_match", { filter, has_find: !!needle });
  }, [loaded, total, needle, filter, shown.length]);

  const headline = !loaded
    ? " "
    : !rows.length
      ? "No bots yet."
      : counts.stopped
        ? `${plural(rows.length, "bot")}. ${counts.stopped} stopped.`
        : `${plural(rows.length, "bot")}.`;

  return (
    <DashLayout title="Bots · loopway" me={me}>
      <section className="ov-top">
        <div>
          <span className="lbl">Bots</span>
          <h1 className="ov-headline">{headline}</h1>
          <p className="muted">
            Each bot reads its inboxes in order and works one thread per issue. Open one to see its threads, prompt and
            rules.
          </p>
        </div>
        <a className="btn btn-md" href="/dashboard/bots/new">
          New bot
        </a>
      </section>

      {loaded && !rows.length && (
        <p className="ov-empty">
          Nothing is running yet. <a href="/dashboard/bots/new">Create your first bot</a> to start.
        </p>
      )}

      {rows.length > 0 && (
        <>
          <section className="bots-bar">
            <div className="range" role="group" aria-label="Filter bots">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={f.key === filter ? "on" : undefined}
                  aria-pressed={f.key === filter}
                  onClick={() => pick(f.key)}
                >
                  {f.label} · {counts[f.key]}
                </button>
              ))}
            </div>
            <div className="bots-find">
              <label htmlFor="find" className="lbl">
                Find
              </label>
              <input id="find" placeholder="Bot or inbox name" value={find} onChange={(e) => setFind(e.target.value)} />
            </div>
          </section>

          <div className="scroll">
            <table className="ledger bots-ledger">
              <thead>
                <tr>
                  <th scope="col">Bot</th>
                  <th scope="col">State</th>
                  <th scope="col">Reads</th>
                  <th scope="col">Runner</th>
                  <th scope="col" className="num">
                    Open
                  </th>
                  <th scope="col" className="num">
                    Waiting
                  </th>
                  <th scope="col">Deliveries, 14 days</th>
                  <th scope="col" className="num">
                    Last delivery
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.bot.id}>
                    <td>
                      <a className="bot-link" href={"/dashboard/bots/" + r.bot.id}>
                        {r.bot.name}
                      </a>
                      <div className="lbl small">
                        {r.bot.model}
                        {r.bot.prompt_version ? ` · prompt v${r.bot.prompt_version.version}` : ""}
                      </div>
                    </td>
                    <td>
                      <StateBadge state={r.state} />
                      {r.reason && <div className="why">{r.reason}</div>}
                    </td>
                    <td className="mono">{r.inboxes.join(", ")}</td>
                    <td className={"mono" + (r.runner ? "" : " muted")}>{r.runner ?? "not held"}</td>
                    <td className="num">{r.open}</td>
                    <td className="num">{r.waiting}</td>
                    <td className="muted">Not available yet</td>
                    <td className="num muted">–</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!shown.length && <p className="muted">No bots match.</p>}

          <section className="bots-note">
            <div>
              <div className="bots-note-head">A bot only works while a runner holds it.</div>
              <div className="muted">
                Leave <span className="mono">loopway bots run</span> open on a machine with the repository checked out.
              </div>
            </div>
            <a className="btn btn-md btn-quiet" href="/dashboard#runners">
              See runners
            </a>
          </section>
        </>
      )}
    </DashLayout>
  );
}
