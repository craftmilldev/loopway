// The Loopway page: what the runner is doing, which bots it holds, and each loopway thread with a link to its bb
// thread. It refetches the server's snapshot on the "state-changed" signal, on reconnect, and every 15 seconds
// for what changes without a signal (like waiting counts).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, Snapshot } from "./status";

const STATE_CHANGED = "state-changed";
const REFRESH_MS = 15_000;

const cn = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

function useSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("state").then(
      (next) => {
        setSnapshot(next);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
    const timer = setInterval(refetch, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refetch]);
  useRealtime(STATE_CHANGED, refetch);
  // Signals aren't replayed, so catch up after a reconnect.
  const connection = useRealtimeConnectionState();
  const seen = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && seen.current !== "connected") refetch();
    seen.current = connection;
  }, [connection, refetch]);
  return { rpc, snapshot, error, refetch };
}

/** The current time, ticking every few seconds so "3s ago" stays true. */
function useNow(ms = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const clock = (at: number | string) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const PHASES: Record<Snapshot["runner"]["phase"], { label: string; dot: string }> = {
  running: { label: "Running", dot: "bg-emerald-500" },
  starting: { label: "Starting", dot: "bg-amber-500 animate-pulse" },
  stopped: { label: "Stopped", dot: "bg-muted-foreground" },
  "needs-configuration": { label: "Needs configuration", dot: "bg-amber-500" },
  error: { label: "Error", dot: "bg-destructive" },
};

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {aside ? <div className="text-xs text-muted-foreground">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function RunnerCard({ runner, now }: { runner: Snapshot["runner"]; now: number }) {
  const phase = PHASES[runner.phase];
  const facts = [
    runner.org && `org ${runner.org}`,
    runner.interval && `polls every ${runner.interval}s`,
    runner.max && `up to ${runner.max} at once`,
    runner.lastTickAt && `last poll ${ago(runner.lastTickAt, now)}`,
    runner.startedAt && `up since ${clock(runner.startedAt)}`,
  ].filter(Boolean);
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className={cn("size-2 shrink-0 rounded-full", phase.dot)} aria-hidden />
        {phase.label}
        {runner.runnerId ? (
          <span className="ml-auto font-mono text-xs font-normal text-muted-foreground" title="Runner id">
            {runner.runnerId}
          </span>
        ) : null}
      </div>
      {facts.length ? <p className="mt-1 text-xs text-muted-foreground">{facts.join(" · ")}</p> : null}
      {runner.message && runner.phase !== "running" ? (
        <p className={cn("mt-2 text-sm", runner.phase === "error" ? "text-destructive" : "text-muted-foreground")}>
          {runner.message}
        </p>
      ) : null}
      {runner.phase === "needs-configuration" ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Set it in Settings → Installed plugins → Loopway runner, or with{" "}
          <code>bb plugin config loopway set &lt;key&gt; &lt;value&gt;</code>.
        </p>
      ) : null}
    </div>
  );
}

/** One small chip per bot. */
function Bots({ bots }: { bots: Snapshot["bots"] }) {
  if (!bots.length) return <EmptyState>No bots yet. Bots with a prompt are picked up each minute.</EmptyState>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {bots.map((bot) => (
        <li key={bot.name} className="rounded-md border border-border bg-card px-2 py-0.5 text-xs">
          {bot.name}
        </li>
      ))}
    </ul>
  );
}

const STATUS_STYLES: Record<Snapshot["threads"][number]["status"], string> = {
  running: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  active: "bg-muted text-foreground",
  ended: "bg-muted text-muted-foreground",
};

function Threads({ threads }: { threads: Snapshot["threads"] }) {
  const navigate = useBbNavigate();
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {threads.map((t) => (
        <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
          <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-xs font-medium", STATUS_STYLES[t.status])}>
            {t.status}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate">{t.subjects.join(", ") || "new thread"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {[
                t.botName,
                <span key="id" className="font-mono" title={t.id}>
                  {t.id.slice(0, 8)}
                </span>,
                t.waiting > 0 && `${t.waiting} waiting`,
                ...t.flags,
              ]
                .filter(Boolean)
                .map((part, i) => (
                  <span key={i}>
                    {i > 0 ? " · " : ""}
                    {part}
                  </span>
                ))}
            </div>
          </div>
          {t.bbThreadId ? (
            <button
              type="button"
              onClick={() => navigate.toThread(t.bbThreadId!)}
              className="flex max-w-[45%] shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              title={`Open bb thread ${t.bbThreadId}`}
            >
              <span className="truncate">{t.bbThreadTitle ?? t.bbThreadId}</span>
              <Icon name="ArrowUpRight" className="size-3.5 shrink-0" />
            </button>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">no bb thread yet</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function LoopwayPage() {
  const { snapshot, error } = useSnapshot();
  const now = useNow();
  const [showEnded, setShowEnded] = useState(false);
  if (!snapshot) {
    return (
      <div className="h-full min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl p-4 md:p-5">
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : (
            <EmptyState>Loading the runner…</EmptyState>
          )}
        </div>
      </div>
    );
  }
  const { runner, bots, threads, moreThreads, otherRunnerThreads, stateError } = snapshot;
  const shown = showEnded ? threads : threads.filter((t) => t.status !== "ended");
  const running = threads.filter((t) => t.status === "running").length;
  const waiting = threads.reduce((n, t) => n + t.waiting, 0);
  const ended = threads.length - threads.filter((t) => t.status !== "ended").length;
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-5 p-4 md:p-5">
        <RunnerCard runner={runner} now={now} />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            Couldn&apos;t refresh: {error}
          </p>
        ) : null}
        {stateError ? (
          <p role="alert" className="text-sm text-destructive">
            Couldn&apos;t read the bots and threads: {stateError}
          </p>
        ) : null}
        {runner.phase === "running" ? (
          <>
            <Section title="Bots">
              <Bots bots={bots} />
            </Section>
            <Section
              title="Threads"
              aside={
                <span className="flex items-center gap-3">
                  <span>
                    {running} running · {waiting} waiting message{waiting === 1 ? "" : "s"}
                    {otherRunnerThreads ? ` · ${otherRunnerThreads} on other runners` : ""}
                  </span>
                  {ended ? (
                    <label className="flex cursor-pointer items-center gap-1">
                      <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} />
                      {ended} ended
                    </label>
                  ) : null}
                </span>
              }
            >
              {shown.length ? (
                <Threads threads={shown} />
              ) : (
                <EmptyState>
                  {threads.length
                    ? "Every thread has ended."
                    : "No threads yet: they start as the bots' messages come in."}
                </EmptyState>
              )}
              {moreThreads ? <p className="text-xs text-muted-foreground">… and {moreThreads} older threads</p> : null}
            </Section>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "runner",
    title: "Loopway",
    icon: "Repeat",
    path: "runner",
    component: LoopwayPage,
  });
});
