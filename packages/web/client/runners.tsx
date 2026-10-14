import { useEffect, useState } from "react";
import { botState, type BotState } from "./bot-state.js";
import { DashLayout } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";
import { StateBadge } from "./overview.js";
import { Updated } from "./updated.js";

type RunnerFilter = "all" | "online" | "offline";

const FILTERS: { key: RunnerFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "online", label: "Online" },
  { key: "offline", label: "Offline" },
];

const COMMANDS = [
  { key: "install", text: "npm i -g @loopway/cli" },
  { key: "login", text: "loopway login" },
  { key: "run", text: "cd ~/code/your-repo && loopway bots run" },
];

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;

function CopyCommand({ command }: { command: (typeof COMMANDS)[number] }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command.text);
    } catch {
      return track("runners_command_copy_failed", { command: command.key });
    }
    track("runners_command_copied", { command: command.key });
    setCopied(true);
  };
  return (
    <div className="copy">
      <code>$ {command.text}</code>
      <button className="btn btn-sm btn-quiet" type="button" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** The commands that start a runner. */
export function SetupPanel() {
  return (
    <section className="runner-setup" aria-label="Start a runner">
      <span className="lbl">Add a runner</span>
      <p className="muted">
        Run these on a machine with the repository checked out, and leave the last one open. Each runner holds the bots
        it can reach.
      </p>
      {COMMANDS.map((c) => (
        <CopyCommand key={c.key} command={c} />
      ))}
    </section>
  );
}

export function Runners() {
  const me = lw.useMe();
  const ready = !!me;
  const runners = lw.useList<lw.Runner>(lw.inOrg("/runners"), ready);
  lw.usePoll(runners.reload, ready);
  const [states, setStates] = useState<Record<string, BotState>>({});
  const [filter, setFilter] = useState<RunnerFilter>("all");
  const [find, setFind] = useState("");

  // The state of each bot a runner holds, which comes from its active threads and so one request per bot.
  const held = [...new Set((runners.data ?? []).flatMap((r) => r.bots.map((b) => b.id)))].sort();
  const loadStates = async () => {
    let ok = true;
    await Promise.all(
      held.map(async (id) => {
        const r = await lw.api(`/bots/${id}/threads?status=active`);
        if (!r.ok) {
          ok = false;
          return track("runners_load_failed", { resource: "threads", status: r.status });
        }
        const threads = ((await r.json()) as { data: lw.Thread[] }).data;
        const state = botState(threads, runners.data ?? []);
        setStates((s) => (s[id] === state ? s : { ...s, [id]: state }));
      }),
    );
    return ok;
  };
  useEffect(() => {
    void loadStates();
  }, [held.join(","), runners.data]); // eslint-disable-line react-hooks/exhaustive-deps
  lw.usePoll(loadStates, ready && !!runners.data);

  const loaded = !!runners.data;
  const list = runners.data ?? [];
  const isOnline = (r: lw.Runner) => !!r.leased_until;
  const counts: Record<RunnerFilter, number> = {
    all: list.length,
    online: list.filter(isOnline).length,
    offline: list.filter((r) => !isOnline(r)).length,
  };
  const needle = find.trim().toLowerCase();
  const shown = list.filter(
    (r) =>
      (filter === "all" || (filter === "online") === isOnline(r)) &&
      (!needle || [r.name, ...r.bots.map((b) => b.name)].some((n) => n.toLowerCase().includes(needle))),
  );
  const stranded = list.filter((r) => !isOnline(r) && r.threads > 0).length;

  useEffect(() => {
    if (loaded) track("runners_viewed", { count: list.length, online: counts.online, stranded });
  }, [loaded, list.length, counts.online, stranded]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (key: RunnerFilter) => {
    track("runners_filter_changed", { filter: key });
    setFilter(key);
  };
  // A filter or find that leaves nothing is where this page gives up on the user, so that's recorded.
  useEffect(() => {
    if (loaded && list.length && !shown.length) track("runners_none_match", { filter, has_find: !!needle });
  }, [loaded, list.length, needle, filter, shown.length]);

  const headline = !loaded
    ? " "
    : !list.length
      ? "No runners yet."
      : `${counts.online} of ${plural(list.length, "runner")} online.`;

  return (
    <DashLayout title="Runners · loopway" me={me}>
      <section className="ov-top">
        <div>
          <span className="lbl">Runners</span>
          <h1 className="ov-headline">{headline}</h1>
          <Updated />
          <p className="muted">
            A runner is a machine running <span className="mono">loopway bots run</span>. A bot only works while a
            runner holds it.
          </p>
        </div>
      </section>

      {loaded && !list.length && (
        <>
          <p className="ov-empty">
            Nothing is running your bots. A runner is a process on one of your machines that does the work of a bot, in
            your repository.
          </p>
          <SetupPanel />
        </>
      )}

      {list.length > 0 && (
        <>
          <section className="bots-bar">
            <div className="range" role="group" aria-label="Filter runners">
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
              <input
                id="find"
                placeholder="Runner or bot name"
                value={find}
                onChange={(e) => setFind(e.target.value)}
              />
            </div>
          </section>

          <div className="scroll">
            <table className="ledger runners-ledger">
              <thead>
                <tr>
                  <th scope="col">Runner</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last seen</th>
                  <th scope="col">Bots</th>
                  <th scope="col" className="num">
                    Threads
                  </th>
                  <th scope="col">Lease runs out</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const online = isOnline(r);
                  return (
                    <tr key={r.id}>
                      <td>
                        <span className="mono">{r.name}</span>
                        <div className="lbl small">{r.org}</div>
                      </td>
                      <td>
                        <span className={"state " + (online ? "state-working" : "state-stranded")}>
                          {online ? "online" : "offline"}
                        </span>
                        {!online && r.threads > 0 && (
                          <div className="why">
                            Its {plural(r.threads, "thread")} {r.threads === 1 ? "is" : "are"} stranded. Restart the
                            runner, or release the threads from the thread page.
                          </div>
                        )}
                      </td>
                      <td title={lw.when(r.last_seen_at)}>{lw.ago(r.last_seen_at)}</td>
                      <td>
                        {r.bots.length ? (
                          r.bots.map((b) => (
                            <div key={b.id} className="runner-bot">
                              <a className="bot-link" href={lw.orgBase() + "/bots/" + b.id}>
                                {b.name}
                              </a>{" "}
                              {states[b.id] && <StateBadge state={states[b.id]!} />}
                            </div>
                          ))
                        ) : (
                          <span className="muted">none</span>
                        )}
                      </td>
                      <td className="num">{r.threads}</td>
                      <td className={online ? undefined : "muted"} title={lw.when(r.leased_until)}>
                        {online ? lw.when(r.leased_until) : "expired"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!shown.length && <p className="muted">No runners match.</p>}

          <SetupPanel />
        </>
      )}
    </DashLayout>
  );
}
