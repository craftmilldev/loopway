import { useEffect, useState } from "react";
import { AgentPrompt } from "./agent-prompt.js";
import { botState, countThreads, filterOf, stateReason, type BotFilter } from "./bot-state.js";
import type { Inbox } from "./shared.js";
import { BotsTable, type BotRow } from "./bots-table.js";
import { BAR_DAYS } from "./delivery-bars.js";
import { DashLayout } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";
import { InboxesSection } from "./inboxes.js";
import { Updated } from "./updated.js";

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
  const bots = lw.useList<lw.Bot>(lw.inOrg("/bots"), ready);
  const runners = lw.useList<lw.Runner>(lw.inOrg("/runners"), ready);
  const inboxes = lw.useList<Inbox>(lw.inOrg("/inboxes"), ready);
  const orgs = lw.useOrgs(ready);
  lw.usePoll(bots.reload, ready);
  lw.usePoll(runners.reload, ready);
  lw.usePoll(inboxes.reload, ready);
  const [threads, setThreads] = useState<Record<string, lw.Thread[]>>({});
  const [activity, setActivity] = useState<Record<string, lw.BotActivity> | null>(null);
  const [filter, setFilter] = useState<BotFilter>("all");
  const [find, setFind] = useState("");

  // Each bot's active threads. One request per bot. A refresh keeps what it has when a request fails.
  const loadThreads = async () => {
    let ok = true;
    await Promise.all(
      (bots.data ?? []).map(async (b) => {
        const r = await lw.api(`/bots/${b.id}/threads?status=active`);
        if (!r.ok) {
          ok = false;
          return track("bots_load_failed", { resource: "threads", status: r.status });
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

  // Every bot's deliveries, in one call.
  const loadActivity = async () => {
    const r = await lw.api(lw.inOrg("/bots/activity?days=" + BAR_DAYS));
    if (!r.ok) {
      track("bots_load_failed", { resource: "activity", status: r.status });
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
          ...countThreads(ts),
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

  const tableRow = (r: (typeof rows)[number]): BotRow => {
    const a = activity?.[r.bot.id];
    const org = lw.orgLabel(orgs, bots.data!, r.bot.org_id);
    return {
      id: r.bot.id,
      name: r.bot.name,
      href: lw.orgBase() + "/bots/" + r.bot.id,
      detail:
        (org ? org + " · " : "") +
        r.bot.model +
        (r.bot.prompt_version ? ` · prompt v${r.bot.prompt_version.version}` : ""),
      state: r.state,
      reason: r.reason,
      reads: r.inboxes.join(", "),
      runner: r.runner,
      open: r.open,
      waiting: r.waiting,
      activity: a,
      last: activity ? (a?.last_delivery_at ? lw.ago(a.last_delivery_at) : null) : undefined,
    };
  };

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
          <Updated />
          <p className="muted">
            Each bot reads its inboxes in order and works one thread per issue. Open one to see its threads, prompt and
            rules.
          </p>
        </div>
        <a
          className="btn btn-md btn-quiet"
          href={lw.orgBase() + "/bots/new"}
          onClick={() => track("bots_create_by_hand_clicked")}
        >
          Create by hand
        </a>
      </section>

      <AgentPrompt from="bots" />

      {loaded && !rows.length && (
        <p className="ov-empty">Nothing is running yet. Give the prompt above to your agent.</p>
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

          <BotsTable rows={shown.map(tableRow)} />
          {!shown.length && <p className="muted">No bots match.</p>}

          <section className="bots-note">
            <div>
              <div className="bots-note-head">A bot only works while a runner holds it.</div>
              <div className="muted">
                Leave <span className="mono">loopway bots run</span> open on a machine with the repository checked out.
              </div>
            </div>
            <a className="btn btn-md btn-quiet" href={lw.orgBase() + "/runners"}>
              See runners
            </a>
          </section>
        </>
      )}

      {loaded && <InboxesSection inboxes={inboxes.data!} bots={bots.data!} orgs={orgs} />}
    </DashLayout>
  );
}
