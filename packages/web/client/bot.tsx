import { useEffect, useState, type FormEvent } from "react";
import { botState, countThreads } from "./bot-state.js";
import { BotSwitcher } from "./bot-switcher.js";
import { DeliveryBars } from "./delivery-bars.js";
import { StateBadge } from "./overview.js";
import { leaseText, type Inbox } from "./dashboard.js";
import { DashLayout } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";
import { PromptTab } from "./prompt.js";

type Status = "active" | "ended" | "all";

export type Tab = "activity" | "threads" | "prompt" | "settings";

const TABS: { key: Tab; label: string }[] = [
  { key: "activity", label: "Activity" },
  { key: "threads", label: "Threads" },
  { key: "prompt", label: "Prompt and rules" },
  { key: "settings", label: "Settings" },
];

/** The tab a `?tab=` value names; anything else is Activity. */
export const tabOf = (value: string | null): Tab => (value === "threads" || value === "settings" ? value : "activity");

/** A bot's page on `tab`. Activity is the bare bot URL, and Prompt and rules has a path of its own. */
export const tabPath = (botId: string, tab: Tab) =>
  lw.orgBase() +
  "/bots/" +
  encodeURIComponent(botId) +
  (tab === "activity" ? "" : tab === "prompt" ? "/prompt" : "?tab=" + tab);

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;

/** "4 min", "1 h 5 min" for a wait in seconds; "–" when nothing was delivered. */
export function waitText(seconds: number | null) {
  if (seconds === null) return "–";
  if (seconds < 60) return Math.round(seconds) + " s";
  const min = Math.round(seconds / 60);
  if (min < 60) return min + " min";
  return `${Math.floor(min / 60)} h${min % 60 ? " " + (min % 60) + " min" : ""}`;
}

/** A bot's page. `view` names the tab when the path picks it (the prompt tab); otherwise `?tab=` does. */
export function Bot({ id, view }: { id: string; view?: Tab }) {
  const me = lw.useMe();
  const ready = !!me;
  const tab = view ?? tabOf(new URLSearchParams(location.search).get("tab"));
  const botPath = "/bots/" + encodeURIComponent(id);
  const bot = lw.useGet<lw.Bot>(botPath, ready);
  const bots = lw.useList<lw.Bot>(lw.inOrg("/bots"), ready);
  const runners = lw.useList<lw.Runner>(lw.inOrg("/runners"), ready);
  const inboxes = lw.useList<Inbox>(lw.inOrg("/inboxes"), ready);
  const open = lw.useList<lw.Thread>(botPath + "/threads?status=active", ready);
  // The bot (its current prompt version, name, inboxes) and the inboxes feed the Prompt and Settings forms, so they
  // load once. The bots, runners and open threads, which give the state, are what refreshes.
  lw.usePoll(bots.reload, ready);
  lw.usePoll(runners.reload, ready);
  lw.usePoll(open.reload, ready);
  const [error, setError] = useState<string | null>(null);

  const runner = (rid: string | null) => runners.data?.find((r) => r.id === rid);
  const b = bot.data;
  const state = open.data && runners.data ? botState(open.data, runners.data) : null;
  const waiting = countThreads(open.data ?? []).waiting;
  const stopped = state === "limited" || state === "stranded";

  useEffect(() => {
    if (b) track("bot_tab_viewed", { tab });
  }, [b?.id, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (bot.missing) track("bot_not_found");
  }, [bot.missing]);
  useEffect(() => {
    if (stopped) track("bot_banner_shown", { state });
  }, [stopped, state]);

  async function remove() {
    if (!confirm(`Delete ${b?.name}? Its threads are deleted with it.`)) return track("bot_delete_cancelled");
    const r = await lw.api(botPath, { method: "DELETE" });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) {
      track("bot_delete_failed", { status: r.status });
      return setError(await lw.message(r));
    }
    location.assign(lw.orgBase());
  }

  return (
    <DashLayout title="Bot · loopway" me={me}>
      {bots.data && (
        <BotSwitcher
          bots={bots.data}
          current={id}
          currentState={state}
          runners={runners.data}
          pathFor={(botId) => tabPath(botId, tab)}
        />
      )}
      <div className="page-head">
        <div>
          <h1>
            {bot.missing ? "Bot not found" : (b?.name ?? "Bot")} {state && <StateBadge state={state} />}
          </h1>
          {b && (
            <div className="muted mono">
              {b.model} · reads{" "}
              {b.inbox_ids.map((i, n) => {
                const inbox = inboxes.data?.find((x) => x.id === i);
                return (
                  <span key={i}>
                    {n > 0 && ", "}
                    <a href={lw.orgBase() + "/inboxes/" + i}>{inbox?.name ?? i}</a>
                  </span>
                );
              })}{" "}
              · {leaseText(b, runner(b.runner_id)?.name)} · read up to #{b.cursor}
            </div>
          )}
        </div>
      </div>
      {b && (
        <nav className="tabs" aria-label="Bot sections">
          <TabLink botId={id} tab="activity" current={tab} />
          <TabLink botId={id} tab="threads" current={tab} />
          <TabLink
            botId={id}
            tab="prompt"
            current={tab}
            suffix={b.prompt_version ? ` · v${b.prompt_version.version}` : ""}
          />
          <TabLink botId={id} tab="settings" current={tab} />
        </nav>
      )}
      {stopped && (
        <div className="banner" role="alert">
          <strong>{state === "limited" ? "Stopped at its usage limit." : "Stranded: its runner is offline."}</strong>{" "}
          {state === "limited" ? "It carries on when the limit resets." : "It carries on when a runner holds it again."}{" "}
          {plural(waiting, "message")} waiting.
        </div>
      )}
      {error && <p className="error">{error}</p>}

      {b && tab === "activity" && <ActivityTab botId={id} botPath={botPath} threads={open.data} />}
      {b && tab === "threads" && <ThreadsTab botId={id} botPath={botPath} runners={runners.data} onError={setError} />}
      {b && tab === "prompt" && (
        <PromptTab botPath={botPath} current={b.prompt_version} onSaved={() => void bot.reload()} />
      )}
      {b && tab === "settings" && (
        <EditBot
          bot={b}
          inboxes={inboxes.data ?? []}
          onSaved={() => void bot.reload()}
          onDelete={() => void remove()}
        />
      )}
    </DashLayout>
  );
}

function TabLink({ botId, tab, current, suffix }: { botId: string; tab: Tab; current: Tab; suffix?: string }) {
  const label = TABS.find((t) => t.key === tab)!.label;
  return (
    <a
      href={tabPath(botId, tab)}
      className={tab === current ? "on" : undefined}
      aria-current={tab === current ? "page" : undefined}
    >
      {label}
      {suffix}
    </a>
  );
}

function ActivityTab({ botId, botPath, threads }: { botId: string; botPath: string; threads: lw.Thread[] | null }) {
  const week = lw.useGet<lw.BotActivity>(botPath + "/activity?days=7", true);
  const month = lw.useGet<lw.BotActivity>(botPath + "/activity?days=30", true);
  const versions = lw.useList<lw.BotVersion>(botPath + "/versions", true);
  lw.usePoll(week.reload, true);
  lw.usePoll(month.reload, true);
  const w = week.data;
  const m = month.data;
  const today = m?.days[m.days.length - 1]?.delivered;
  const inflight = threads?.reduce((n, t) => n + t.inflight.length, 0);
  const waiting = threads && countThreads(threads).waiting;

  return (
    <div className="ov-split bot-split">
      <div className="ov-main">
        <section className="figures" aria-label="Last 7 days">
          <Figure label="Open threads" value={threads?.length} />
          <Figure label="Delivered, 7 days" value={w?.delivered} note={w ? "in " + plural(w.runs, "run") : undefined} />
          <Figure
            label="Median wait"
            value={w ? waitText(w.median_wait_seconds) : undefined}
            note="assigned to delivered"
          />
        </section>
        <h2>Delivered per day, 30 days</h2>
        <div className="bars-large">
          <DeliveryBars activity={m ?? undefined} days={30} height={120} />
        </div>
      </div>
      <aside className="ov-side">
        <h2>Right now</h2>
        <dl className="now">
          <dt>Messages waiting</dt>
          <dd>{waiting ?? "…"}</dd>
          <dt>Messages inflight</dt>
          <dd>{inflight ?? "…"}</dd>
          <dt>Delivered today</dt>
          <dd>{today ?? "…"}</dd>
        </dl>
        <h2>Prompt versions</h2>
        <ul className="list">
          {versions.data?.slice(0, 3).map((v) => (
            <li key={v.version}>
              <a className="type" href={tabPath(botId, "prompt")}>
                Version {v.version}
              </a>{" "}
              <span className="muted">{lw.when(v.created_at)}</span>
            </li>
          ))}
        </ul>
        {versions.data?.length === 0 && <p className="muted">No versions yet.</p>}
      </aside>
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: string | number | undefined; note?: string }) {
  return (
    <div className="figure">
      <span className="lbl">{label}</span>
      <span className="figure-value">{value ?? "…"}</span>
      {note && <span className="muted">{note}</span>}
    </div>
  );
}

const FILTERS: { key: Status; label: string }[] = [
  { key: "active", label: "Open" },
  { key: "ended", label: "Ended" },
  { key: "all", label: "All" },
];

function ThreadsTab({
  botId,
  botPath,
  runners,
  onError,
}: {
  botId: string;
  botPath: string;
  runners: lw.Runner[] | null;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<Status>("active");
  const threads = lw.useList<lw.Thread>(botPath + "/threads?status=" + status, true);
  lw.usePoll(threads.reload, true);

  async function release(t: lw.Thread) {
    const name = runners?.find((r) => r.id === t.runner_id)?.name ?? "its runner";
    if (!confirm(`Release this thread from ${name}? The next runner to claim it starts it fresh.`)) return;
    const r = await lw.api(`${botPath}/threads/${t.id}/release`, { method: "POST", body: {} });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) {
      track("thread_release_failed", { status: r.status });
      return onError(await lw.message(r));
    }
    void threads.reload();
  }

  return (
    <>
      <div className="range" role="group" aria-label="Filter threads">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={f.key === status ? "on" : undefined}
            aria-pressed={f.key === status}
            onClick={() => {
              track("bot_threads_filter_changed", { filter: f.key });
              setStatus(f.key);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="scroll">
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">Thread</th>
              <th scope="col">State</th>
              <th scope="col" className="num">
                Messages waiting
              </th>
              <th scope="col" className="num">
                Delivered
              </th>
              <th scope="col">Updated</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {threads.data?.map((t) => (
              <tr key={t.id}>
                <td>
                  <a href={`${lw.orgBase()}/bots/${encodeURIComponent(botId)}/threads/${t.id}`}>
                    {t.title ?? (t.subjects.length ? t.subjects.join(", ") : t.id)}
                  </a>
                  {t.title && (
                    <div className="thread-meta">
                      <SubjectChips subjects={t.subjects} />
                    </div>
                  )}
                </td>
                <td>
                  {t.status}
                  <Flags t={t} />
                </td>
                <td className="num">{t.waiting.length}</td>
                <td className="num">{t.delivered}</td>
                <td>{lw.when(t.updated_at)}</td>
                <td>
                  {t.runner_id && !runners?.find((r) => r.id === t.runner_id)?.leased_until && (
                    <button className="btn btn-sm btn-quiet" type="button" onClick={() => void release(t)}>
                      Release
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {threads.data?.length === 0 && (
        <p className="muted">No {status === "all" ? "" : (status === "active" ? "open" : status) + " "}threads.</p>
      )}
    </>
  );
}

function Flags({ t }: { t: lw.Thread }) {
  return (
    <>
      {t.interrupted && <span className="badge">interrupted</span>}
      {t.limited && <span className="badge">limited</span>}
    </>
  );
}

function EditBot({
  bot,
  inboxes,
  onSaved,
  onDelete,
}: {
  bot: lw.Bot;
  inboxes: Inbox[];
  onSaved: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(bot.name);
  const [model, setModel] = useState(bot.model);
  const [checked, setChecked] = useState(new Set(bot.inbox_ids));
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string, on: boolean) {
    const next = new Set(checked);
    if (on) next.add(id);
    else next.delete(id);
    setChecked(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!checked.size) {
      track("bot_edit_no_inbox");
      return setError("Pick at least one inbox.");
    }
    const r = await lw.api("/bots/" + bot.id, { method: "PATCH", body: { name, model, inbox_ids: [...checked] } });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) {
      track("bot_edit_failed", { status: r.status });
      return setError(await lw.message(r));
    }
    onSaved();
  }

  return (
    <form className="panel" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label htmlFor="bot-name">Name</label>
        <div className="input-wrap">
          <input id="bot-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="bot-model">Model</label>
        <div className="input-wrap">
          <select id="bot-model" value={model} onChange={(e) => setModel(e.target.value)}>
            {(lw.BOT_MODELS.includes(model) ? lw.BOT_MODELS : [model, ...lw.BOT_MODELS]).map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Inboxes</label>
        <div className="checks">
          {inboxes.map((i) => (
            <label key={i.id} className="check">
              <input type="checkbox" checked={checked.has(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} />{" "}
              {i.name}
            </label>
          ))}
        </div>
      </div>
      <div className="form-actions">
        <button className="btn" type="submit">
          Save
        </button>
        <button className="btn btn-quiet" type="button" onClick={onDelete}>
          Delete bot
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

/** Delivered messages grouped into runs (the ones delivered together), the newest run first. */
export function runsOf<M extends { delivered_at: string | null }>(messages: M[]) {
  const byTime = new Map<string, M[]>();
  for (const m of messages) byTime.set(m.delivered_at ?? "", [...(byTime.get(m.delivered_at ?? "") ?? []), m]);
  const time = (at: string) => (at ? new Date(at).getTime() : 0);
  const runs = [...byTime].sort(([a], [b]) => time(a) - time(b));
  return runs.map(([at, ms], i) => ({ number: i + 1, at: at || null, messages: ms })).reverse();
}

export function Thread({ botId, id }: { botId: string; id: string }) {
  const me = lw.useMe();
  const ready = !!me;
  const botPath = "/bots/" + encodeURIComponent(botId);
  const threadPath = `${botPath}/threads/${encodeURIComponent(id)}`;
  const bot = lw.useGet<lw.Bot>(botPath, ready);
  const thread = lw.useGet<lw.Thread>(threadPath, ready);
  const runners = lw.useList<lw.Runner>(lw.inOrg("/runners"), ready);
  lw.usePoll(bot.reload, ready);
  lw.usePoll(thread.reload, ready);
  lw.usePoll(runners.reload, ready);
  const [error, setError] = useState<string | null>(null);
  const t = thread.data;
  const owner = runners.data?.find((r) => r.id === t?.runner_id);
  const online = !!owner?.leased_until;
  const runs = runsOf(t?.delivered_messages ?? []);
  const state = t && runners.data && t.status === "active" ? botState([t], runners.data) : null;

  useEffect(() => {
    if (t) track("thread_viewed", { status: t.status, titled: !!t.title });
  }, [t?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function release() {
    if (!t) return;
    if (
      !confirm(`Release this thread from ${owner?.name ?? "its runner"}? The next runner to claim it starts it fresh.`)
    )
      return track("thread_release_cancelled");
    const r = await lw.api(`${threadPath}/release`, { method: "POST", body: {} });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) {
      track("thread_release_failed", { status: r.status });
      return setError(await lw.message(r));
    }
    track("thread_released");
    setError(null);
    void thread.reload();
  }

  async function end() {
    if (!t) return;
    if (!confirm("End this thread? It can't be undone from here.")) return track("thread_end_cancelled");
    const r = await lw.api(`${threadPath}/end`, { method: "POST", body: {} });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) {
      track("thread_end_failed", { status: r.status });
      return setError(await lw.message(r));
    }
    track("thread_ended", { runner_online: online });
    setError(null);
    void thread.reload();
  }

  return (
    <DashLayout
      title="Thread · loopway"
      me={me}
      crumb={
        <p className="crumb">
          <a href={lw.orgBase() + "/bots/" + botId}>← {bot.data?.name ?? "Bot"}</a>
        </p>
      }
    >
      <div className="page-head">
        <div>
          <h1>{thread.missing ? "Thread not found" : (t?.title ?? "Thread")}</h1>
          {t && (
            <div className="thread-meta">
              <SubjectChips subjects={t.subjects} />
              {state ? <StateBadge state={state} /> : <span className="state state-idle">{t.status}</span>}
              <Flags t={t} />
            </div>
          )}
        </div>
        {t && (
          <div className="thread-actions">
            <button
              className="btn btn-quiet"
              type="button"
              disabled={!t.runner_id || !runners.data || online}
              title={!t.runner_id ? "No runner owns this thread" : online ? "Its runner is online" : undefined}
              onClick={() => void release()}
            >
              Release
            </button>
            {t.status === "active" && (
              <button className="btn btn-quiet" type="button" onClick={() => void end()}>
                End thread
              </button>
            )}
          </div>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {t && (
        <div className="thread-layout">
          <div className="thread-main">
            <Group title="Waiting" messages={t.waiting} />
            <Group title="In flight" messages={t.inflight} />
            {runs.map((run) => (
              <Group key={run.at ?? run.number} title={`Run ${run.number}`} at={run.at} messages={run.messages} />
            ))}
          </div>
          <aside className="thread-side" aria-label="Thread details">
            <dl>
              <dt>Runner</dt>
              <dd>
                {t.runner_id ? (owner?.name ?? "an unknown runner") : "none yet"}
                {t.runner_id && <span className="muted"> · {online ? "online" : "offline"}</span>}
              </dd>
              <dt>Started</dt>
              <dd>{lw.when(t.created_at)}</dd>
              <dt>Runs</dt>
              <dd>{runs.length}</dd>
              <dt>Messages</dt>
              <dd>{t.waiting.length + t.inflight.length + t.delivered}</dd>
              <dt>Prompt version</dt>
              <dd>{bot.data?.prompt_version ? "v" + bot.data.prompt_version.version : "–"}</dd>
              <dt>Transcript</dt>
              <dd>
                <code className="mono">tail -f ~/.loopway/threads/{t.id}.log</code>
                {t.runner_id && <span className="muted"> on {owner?.name ?? "the runner"}</span>}
              </dd>
            </dl>
          </aside>
        </div>
      )}
    </DashLayout>
  );
}

/** A thread's subjects, each a chip linking to GitHub where it can. */
export function SubjectChips({ subjects }: { subjects: string[] }) {
  return (
    <>
      {subjects.map((s) => {
        const url = lw.subjectUrl(s);
        return url ? (
          <a key={s} className="chip" href={url} target="_blank" rel="noreferrer">
            {s}
          </a>
        ) : (
          <span key={s} className="chip">
            {s}
          </span>
        );
      })}
    </>
  );
}

interface Row {
  id: string;
  inbox_id: string;
  type: string;
  summary: string | null;
}

function Group({ title, at, messages }: { title: string; at?: string | null; messages: Row[] }) {
  if (!messages.length) return null;
  return (
    <section className="thread-group">
      <div className="lbl">
        {title} <span className="muted">{messages.length}</span>
        {at && <span className="when">{lw.when(at)}</span>}
      </div>
      {messages.map((m) => (
        <MessageRow key={m.id} m={m} />
      ))}
    </section>
  );
}

// The thread only lists a message's id, so its JSON is fetched from its inbox when the row is opened.
function MessageRow({ m }: { m: Row }) {
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState<unknown>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || event) return;
    track("thread_event_opened", { type: m.type });
    void lw.api(`/inboxes/${m.inbox_id}/messages/${m.id}`).then(async (r) => {
      if (!r.ok) {
        track("thread_event_load_failed", { status: r.status });
        return setFailed(true);
      }
      setEvent(((await r.json()) as { event: unknown }).event);
    });
  }, [open, event, m.inbox_id, m.id, m.type]);

  return (
    <details className="message" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <div>
          <div>{m.summary ?? m.type}</div>
          {m.summary && <div className="type">{m.type}</div>}
        </div>
        <span className="lbl">Event</span>
      </summary>
      <pre>{failed ? "Couldn't load this message." : event ? JSON.stringify(event, null, 2) : "Loading…"}</pre>
    </details>
  );
}
