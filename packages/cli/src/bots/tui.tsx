import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { ago, clock } from "../format.js";
import type { DispatcherState } from "./dispatcher.js";
import { transcriptLines, wrap, type TranscriptLine } from "./transcript.js";

/** What the TUI shows, reloaded every second. */
export interface Snapshot extends DispatcherState {
  /** The dispatcher's latest log line. */
  message?: string;
}

export interface TuiProps {
  load: () => Promise<Snapshot>;
  /** A session's transcript, or "" if it has none yet. */
  readLog: (sessionId: string) => Promise<string>;
  refreshMs?: number;
}

type Section = "working" | "waiting" | "done";
const SECTIONS: Section[] = ["working", "waiting", "done"];
const TITLES: Record<Section, string> = { working: "Working", waiting: "Waiting", done: "Done" };
const KIND_STYLE: Record<TranscriptLine["kind"], { color?: string; dimColor?: boolean }> = {
  text: {},
  tool: { color: "cyan" },
  result: { dimColor: true },
  error: { color: "red" },
  meta: { dimColor: true },
};

/** Runs the TUI full-screen until the user quits, or `signal` aborts. */
export async function showTui(props: TuiProps, signal?: AbortSignal): Promise<void> {
  const app = render(<ThreadsTui {...props} />, { alternateScreen: true });
  signal?.addEventListener("abort", () => app.unmount(), { once: true });
  await app.waitUntilExit();
}

/**
 * The threads TUI: waiting messages, then working, waiting and done sessions. ↑/↓ moves between
 * sessions (messages can't be opened), Tab jumps to the next list, Enter or → opens a session's transcript.
 */
export function ThreadsTui({ load, readLog, refreshMs = 1000 }: TuiProps) {
  const [snap, setSnap] = useState<Snapshot>();
  const [selected, setSelected] = useState<string>();
  const [open, setOpen] = useState<string>();
  useEffect(() => poll(load, setSnap, refreshMs), [load, refreshMs]);

  if (!snap) return <Text dimColor>Loading…</Text>;
  if (open)
    return <LogView id={open} snap={snap} readLog={readLog} refreshMs={refreshMs} onBack={() => setOpen(undefined)} />;
  return <ListView snap={snap} selected={selected} onSelect={setSelected} onOpen={setOpen} />;
}

/** Sorts threads into the three lists, most recently updated first. */
export function sessionLists({ threads, running }: DispatcherState): Record<Section, string[]> {
  const ids = Object.keys(threads).sort((a, b) => threads[b]!.updated_at.localeCompare(threads[a]!.updated_at));
  const lists: Record<Section, string[]> = { working: [], waiting: [], done: [] };
  for (const id of ids) lists[sectionOf({ threads, running }, id)].push(id);
  return lists;
}

const sectionOf = ({ threads, running }: Pick<DispatcherState, "threads" | "running">, id: string): Section =>
  running.has(id) ? "working" : threads[id]?.status === "ended" ? "done" : "waiting";

/** " on <runner>" for a thread another runner owns (its session lives on that machine), "" for this runner's. */
const owner = ({ threads, runnerId, runners }: DispatcherState, id: string): string => {
  const runner = threads[id]?.runner_id;
  return runner && runner !== runnerId ? ` on ${runners[runner] ?? runner.slice(0, 8)}` : "";
};

/** The name of the bot a thread belongs to, to tell the threads of different bots apart. */
const botName = ({ bots }: Pick<DispatcherState, "bots">, id: string): string =>
  [...bots.held, ...bots.skipped].find((b) => b.id === id)?.name ?? id.slice(0, 8);

interface Row {
  key: string;
  /** Set on rows that can be selected (sessions). */
  id?: string;
  header?: string;
  label?: string;
  meta?: string;
}

interface ListViewProps {
  snap: Snapshot;
  selected: string | undefined;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}

function ListView({ snap, selected, onSelect, onOpen }: ListViewProps) {
  const { exit } = useApp();
  const { rows: height } = useWindowSize();
  const lists = sessionLists(snap);
  const order = SECTIONS.flatMap((s) => lists[s]);
  const current = selected && order.includes(selected) ? selected : order[0];

  useInput((input, key) => {
    const i = current ? order.indexOf(current) : -1;
    if (input === "q") exit();
    else if (key.upArrow && i > 0) onSelect(order[i - 1]!);
    else if (key.downArrow && i >= 0 && i < order.length - 1) onSelect(order[i + 1]!);
    else if (key.tab && current) {
      const filled = SECTIONS.filter((s) => lists[s].length);
      const at = filled.indexOf(sectionOf(snap, current));
      onSelect(lists[filled[(at + (key.shift ? -1 : 1) + filled.length) % filled.length]!][0]!);
    } else if ((key.return || key.rightArrow) && current) onOpen(current);
  });

  // Title above, status and help below; the lists scroll in what's left.
  const body = Math.max(1, height - 3);
  const rows = listRows(snap, lists, Math.max(3, Math.floor(body / 4)));
  const names = (bots: { name: string }[]) => bots.map((b) => b.name).join(", ");
  const leased = snap.bots.skipped.map((b) => b.name + (b.leased_until ? ` (until ${clock(b.leased_until)})` : ""));
  const skipped = leased.length ? ` · leased elsewhere: ${leased.join(", ")}` : "";

  // Scroll just enough to keep the selection on screen, along with its list's header.
  const offset = useRef(0);
  const sel = rows.findIndex((r) => r.id === current);
  if (sel >= 0) {
    const top = rows[sel - 1]?.header ? sel - 1 : sel;
    if (top < offset.current) offset.current = top;
    else if (sel >= offset.current + body) offset.current = sel - body + 1;
  }
  offset.current = Math.max(0, Math.min(offset.current, rows.length - body));

  return (
    <Box flexDirection="column" height={height}>
      <Text bold>
        loopway bots run{" "}
        <Text dimColor>
          · {names(snap.bots.held) || "no bots held"}
          {skipped}
        </Text>
      </Text>
      <Box flexDirection="column" height={body} overflow="hidden">
        {rows.slice(offset.current, offset.current + body).map((r) => (
          <ListRow key={r.key} row={r} selected={r.id !== undefined && r.id === current} />
        ))}
      </Box>
      <Text dimColor wrap="truncate-end">
        {snap.message ?? ""}
      </Text>
      <Text dimColor wrap="truncate-end">
        ↑↓ move · tab next list · enter/→ open · q quit
      </Text>
    </Box>
  );
}

/** Every row of the list view. Waiting messages stop at `waitingMax` so the session lists stay in view. */
function listRows(snap: Snapshot, lists: Record<Section, string[]>, waitingMax: number): Row[] {
  const rows: Row[] = [{ key: "h-messages", header: `Waiting messages (${snap.waiting.length})` }];
  // The same message waits once per bot that routed it, so a row is keyed by its thread too.
  for (const m of snap.waiting.slice(0, waitingMax)) {
    const where = `${m.bot_name} ${m.thread_id.slice(0, 8)}${snap.running.has(m.thread_id) ? " working" : ""}`;
    rows.push({ key: `${m.thread_id}:${m.id}`, label: m.type, meta: [m.subject, where].filter(Boolean).join("  ") });
  }
  const more = snap.waiting.length - waitingMax;
  if (more > 0) rows.push({ key: "more-messages", meta: `… ${more} more` });
  if (!snap.waiting.length) rows.push({ key: "none-messages", meta: "none" });

  for (const sec of SECTIONS) {
    rows.push({ key: `gap-${sec}` }, { key: `h-${sec}`, header: `${TITLES[sec]} (${lists[sec].length})` });
    for (const id of lists[sec]) {
      const t = snap.threads[id]!;
      rows.push({
        key: id,
        id,
        label: t.subjects.join(", ") || "new thread",
        meta: `${botName(snap, t.bot_id)} ${id.slice(0, 8)}  ${ago(t.updated_at)}${owner(snap, id)}`,
      });
    }
    if (!lists[sec].length) rows.push({ key: `none-${sec}`, meta: "none" });
  }
  return rows;
}

function ListRow({ row, selected }: { row: Row; selected: boolean }) {
  if (row.header) return <Text bold>{row.header}</Text>;
  return (
    <Text wrap="truncate-end" color={selected ? "cyan" : undefined}>
      {selected ? "❯ " : "  "}
      {row.label && <Text bold={selected}>{row.label} </Text>}
      <Text dimColor={!selected}>{row.meta ?? ""}</Text>
    </Text>
  );
}

interface LogViewProps {
  id: string;
  snap: Snapshot;
  readLog: (sessionId: string) => Promise<string>;
  refreshMs: number;
  onBack: () => void;
}

/** A session's transcript. It follows new output until you scroll up, and again once you're back at the end. */
function LogView({ id, snap, readLog, refreshMs, onBack }: LogViewProps) {
  const { exit } = useApp();
  const { rows: height, columns } = useWindowSize();
  const [log, setLog] = useState<string>();
  // undefined: pinned to the end.
  const [top, setTop] = useState<number>();
  useEffect(() => poll(() => readLog(id), setLog, refreshMs), [id, readLog, refreshMs]);

  const lines = useMemo(
    () => transcriptLines(log ?? "").flatMap((l) => wrap(l.text, columns).map((text) => ({ text, kind: l.kind }))),
    [log, columns],
  );
  const body = Math.max(1, height - 2);
  const bottom = Math.max(0, lines.length - body);
  const start = Math.min(top ?? bottom, bottom);
  const scroll = (to: number) => setTop(to >= bottom ? undefined : Math.max(0, to));

  useInput((input, key) => {
    if (input === "q") exit();
    else if (key.leftArrow) onBack();
    else if (key.upArrow) scroll(start - 1);
    else if (key.downArrow) scroll(start + 1);
    else if (key.pageUp) scroll(start - body);
    else if (key.pageDown) scroll(start + body);
    else if (key.home) scroll(0);
    else if (key.end) scroll(bottom);
  });

  const thread = snap.threads[id];
  const empty = log === undefined ? "Loading…" : "No transcript yet.";
  return (
    <Box flexDirection="column" height={height}>
      <Text bold wrap="truncate-end">
        {thread?.subjects.join(", ") || "new thread"}{" "}
        <Text dimColor>
          · {id.slice(0, 8)} · {sectionOf(snap, id)}
          {owner(snap, id)}
        </Text>
      </Text>
      <Box flexDirection="column" height={body} overflow="hidden">
        {lines.length ? (
          lines.slice(start, start + body).map((l, i) => (
            <Text key={start + i} wrap="truncate-end" {...KIND_STYLE[l.kind]}>
              {l.text}
            </Text>
          ))
        ) : (
          <Text dimColor>{empty}</Text>
        )}
      </Box>
      <Text dimColor wrap="truncate-end">
        {lines.length ? `${start + 1}–${Math.min(start + body, lines.length)} of ${lines.length} · ` : ""}↑↓ PgUp/PgDn
        scroll · ← back · q quit
      </Text>
    </Box>
  );
}

/** Calls `fn` now and every `ms` ms, handing each result to `set`; returns the cleanup for useEffect. */
function poll<T>(fn: () => Promise<T>, set: (v: T) => void, ms: number): () => void {
  let live = true;
  // A failed read keeps showing the last one; the next tick tries again.
  const run = () =>
    fn().then(
      (v) => live && set(v),
      () => {},
    );
  void run();
  const timer = setInterval(() => void run(), ms);
  return () => {
    live = false;
    clearInterval(timer);
  };
}
