import { FAINT, INDIGO, INK, LEVEL_COLORS, MADDER, STATE_COLORS, type Level, type State } from "@loopway/palette";
import chalk from "chalk";
import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { ago, clock } from "../format.js";
import { emptyChat, type Chat, type ChatBackend } from "./chat.js";
import { termColor } from "./colors.js";
import type { DispatcherState } from "./dispatcher.js";
import { transcriptLines, wrap, type TranscriptLine } from "./transcript.js";
import { CLI_VERSION } from "../version.js";

/** What the TUI shows, reloaded every second. */
export interface Snapshot extends DispatcherState {
  /** The dispatcher's latest log line. */
  message?: string;
}

export interface TuiProps {
  load: () => Promise<Snapshot>;
  /** A session's transcript, or "" if it has none yet. */
  readLog: (sessionId: string) => Promise<string>;
  /** Sends a message to a thread; rejects with the reason it couldn't. */
  send: (threadId: string, text: string) => Promise<void>;
  /** Ends a thread; rejects with the reason it couldn't. */
  end: (threadId: string) => Promise<void>;
  /** The slug of the org the runner runs bots for. */
  org?: string;
  /** Adds the Chat view (`c`), talking to the opt-in manager bot. Without it the TUI is the lists and transcripts only. */
  chat?: ChatBackend;
  /** Opens in Chat instead of the lists; only with `chat`. */
  startInChat?: boolean;
  /** Records a product metric for the chat view. */
  capture?: (event: string, properties?: Record<string, unknown>) => void;
  refreshMs?: number;
}

type Section = "working" | "waiting" | "done";
const SECTIONS: Section[] = ["working", "waiting", "done"];
const TITLES: Record<Section, string> = { working: "Working", waiting: "Waiting", done: "Done" };

// The landing page's terminal, on a dark ground: secondary text, separators and done rows, rules, and the band behind
// the selected row (ink-200, -300, -600 and -700). Text that isn't secondary keeps the terminal's own color.
const MUTED = INK.ink;
const DIM = FAINT.ink;
const RULE = "#4b4534";
const BAND = "#3a352b";
const BAND_TEXT = "#f2eede";

const KIND_STYLE: Record<TranscriptLine["kind"], { color?: string; dimColor?: boolean }> = {
  text: {},
  tool: { color: INDIGO.ink },
  result: { dimColor: true },
  error: { color: MADDER.ink },
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
export function ThreadsTui({
  load,
  readLog,
  send,
  end,
  org,
  chat: chatOn,
  startInChat,
  capture,
  refreshMs = 1000,
}: TuiProps) {
  const [snap, setSnap] = useState<Snapshot>();
  const [selected, setSelected] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [inChat, setInChat] = useState(!!chatOn && !!startInChat);
  // Kept here so the transcript is still there when you come back from the lists.
  const [chat, setChat] = useState<Chat>(emptyChat);
  useEffect(
    // Only while a run is in flight: a reply reads and parses the whole chat log, so an idle chat is left alone.
    () => (chatOn && chat.thinking ? poll(() => chatOn.read(), setChat, Math.min(refreshMs, 500)) : undefined),
    [chatOn, chat.thinking, refreshMs],
  );
  useEffect(() => poll(load, setSnap, refreshMs), [load, refreshMs]);
  // Only the view it opens in counts as the default, so this reports once.
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    if (inChat && startInChat) capture?.("chat_view_opened", { via: "default" });
  }, [capture, inChat, startInChat]);

  if (inChat)
    return (
      <ChatView
        chat={chat}
        onSubmit={(text) => {
          const { result } = chatOn!.send(text);
          if (result === "sent") capture?.("chat_message_sent", {});
          else capture?.("chat_message_ignored", { reason: result });
          // Shows the message and the thinking state now, not at the next poll.
          void chatOn!.read().then(setChat);
        }}
        onBack={() => setInChat(false)}
      />
    );
  if (!snap) return <Text dimColor>Loading…</Text>;
  if (open)
    return (
      <LogView
        id={open}
        snap={snap}
        readLog={readLog}
        send={send}
        end={end}
        refreshMs={refreshMs}
        onBack={() => setOpen(undefined)}
      />
    );
  return (
    <ListView
      snap={snap}
      org={org}
      selected={selected}
      onSelect={setSelected}
      onOpen={setOpen}
      onChat={
        chatOn
          ? () => {
              capture?.("chat_view_opened", { via: "key" });
              setInChat(true);
            }
          : undefined
      }
    />
  );
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

/**
 * Where a thread stands, in the dashboard's words: working (a run in flight), stranded (its runner's lease ran out),
 * limited (it hit a usage limit), waiting, or done.
 */
export function threadState(
  snap: Pick<DispatcherState, "threads" | "running" | "offline">,
  id: string,
): State | "done" {
  const t = snap.threads[id];
  if (snap.running.has(id)) return "working";
  if (!t || t.status === "ended") return "done";
  if (t.runner_id && snap.offline.has(t.runner_id)) return "stranded";
  return t.limited ? "limited" : "waiting";
}

/** A thread's level; one with none set is level 2, as the dashboard counts it. */
const levelOf = ({ threads }: Pick<DispatcherState, "threads">, id: string): Level =>
  threads[id]?.automation_level ?? 2;

/** " on <runner>" for a thread another runner owns (its session lives on that machine), "" for this runner's. */
const owner = ({ threads, runnerId, runners }: DispatcherState, id: string): string => {
  const runner = threads[id]?.runner_id;
  return runner && runner !== runnerId ? ` on ${runners[runner] ?? runner.slice(0, 8)}` : "";
};

/** The name of the bot a thread belongs to, to tell the threads of different bots apart. */
const botName = ({ bots }: Pick<DispatcherState, "bots">, id: string): string =>
  [...bots.held, ...bots.skipped].find((b) => b.id === id)?.name ?? id.slice(0, 8);

/** What a thread is about: its subjects, then its title. */
const threadLabel = ({ threads }: Pick<DispatcherState, "threads">, id: string): string => {
  const t = threads[id];
  return [t?.subjects.join(", ") || "new thread", t?.title].filter(Boolean).join(" ");
};

/** A state's dot: filled in its color, none for a done thread. */
const Dot = ({ state }: { state: State | "done" }) =>
  state === "done" ? <Text>{"  "}</Text> : <Text color={termColor(STATE_COLORS[state].ink)}>● </Text>;

const LevelMark = ({ level, color }: { level: Level; color?: string }) => (
  <Text color={termColor(color ?? LEVEL_COLORS[level].ink)}>L{level}</Text>
);

interface Row {
  key: string;
  /** Set on rows that can be selected (sessions). */
  id?: string;
  heading?: { title: string; count: number };
  /** Rows with no bot are notes under a heading ("none", "… 3 more"). */
  bot?: string;
  /** undefined: a waiting message, which gets a ring. */
  state?: State | "done";
  label?: string;
  level?: Level;
  meta?: string;
}

interface ListViewProps {
  snap: Snapshot;
  org: string | undefined;
  selected: string | undefined;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  /** Set when the Chat view is on. */
  onChat?: () => void;
}

function ListView({ snap, org, selected, onSelect, onOpen, onChat }: ListViewProps) {
  const { exit } = useApp();
  const { rows: height, columns } = useWindowSize();
  const lists = sessionLists(snap);
  const order = SECTIONS.flatMap((s) => lists[s]);
  const current = selected && order.includes(selected) ? selected : order[0];

  useInput((input, key) => {
    const i = current ? order.indexOf(current) : -1;
    if (input === "q") exit();
    else if (input === "c" && onChat) onChat();
    else if (key.upArrow && i > 0) onSelect(order[i - 1]!);
    else if (key.downArrow && i >= 0 && i < order.length - 1) onSelect(order[i + 1]!);
    else if (key.tab && current) {
      const filled = SECTIONS.filter((s) => lists[s].length);
      const at = filled.indexOf(sectionOf(snap, current));
      onSelect(lists[filled[(at + (key.shift ? -1 : 1) + filled.length) % filled.length]!][0]!);
    } else if ((key.return || key.rightArrow) && current) onOpen(current);
  });

  // Two lines of header above, the status line below; the lists scroll in what's left.
  const body = Math.max(1, height - 3);
  const rows = listRows(snap, lists, Math.max(3, Math.floor(body / 4)));
  // The bot and the meta are columns as wide as their longest, so the levels line up.
  const botWidth = Math.min(20, Math.max(0, ...rows.map((r) => r.bot?.length ?? 0))) + 2;
  const metaWidth = Math.min(40, Math.max(0, ...rows.map((r) => (r.bot === undefined ? 0 : (r.meta?.length ?? 0)))));
  const held = snap.bots.held.map((b) => b.name).join(", ") || "no bots";
  const skipped = snap.bots.skipped.map(
    (b) =>
      `${b.name}, held by ${b.held_by ?? "another runner"}` + (b.leased_until ? ` until ${clock(b.leased_until)}` : ""),
  );
  const sep = <Text color={termColor(DIM)}> · </Text>;

  // Scroll just enough to keep the selection on screen, along with its list's heading.
  const offset = useRef(0);
  const sel = rows.findIndex((r) => r.id === current);
  if (sel >= 0) {
    const top = rows[sel - 1]?.heading ? sel - 1 : sel;
    if (top < offset.current) offset.current = top;
    else if (sel >= offset.current + body) offset.current = sel - body + 1;
  }
  offset.current = Math.max(0, Math.min(offset.current, rows.length - body));

  return (
    <Box flexDirection="column" height={height}>
      <Text wrap="truncate-end">
        <Text bold>LOOPWAY</Text>
        {sep}runner {snap.runners[snap.runnerId] ?? snap.runnerId.slice(0, 8)}
        {org && (
          <>
            {sep}org {org}
          </>
        )}
        {sep}
        <Text color={termColor(DIM)}>v{CLI_VERSION}</Text>
      </Text>
      <Text color={termColor(MUTED)} wrap="truncate-end">
        holds {held}
        {skipped.length > 0 && (
          <>
            {sep}skipped {skipped.join("; ")}
          </>
        )}
      </Text>
      <Box flexDirection="column" height={body} overflow="hidden">
        {rows.slice(offset.current, offset.current + body).map((r) => (
          <ListRow
            key={r.key}
            row={r}
            botWidth={botWidth}
            metaWidth={metaWidth}
            columns={columns}
            selected={r.id !== undefined && r.id === current}
          />
        ))}
      </Box>
      <Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={termColor(MUTED)} wrap="truncate-end">
            {snap.message ?? ""}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={2}>
          <Text color={termColor(MUTED)}>
            ↑↓ move · tab next list · enter/→ open · {onChat ? "c chat · " : ""}q quit
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/** Every row of the list view. Waiting messages stop at `waitingMax` so the session lists stay in view. */
function listRows(snap: Snapshot, lists: Record<Section, string[]>, waitingMax: number): Row[] {
  const rows: Row[] = [{ key: "h-messages", heading: { title: "Waiting messages", count: snap.waiting.length } }];
  // The same message waits once per bot that routed it, so a row is keyed by its thread too.
  for (const m of snap.waiting.slice(0, waitingMax))
    rows.push({
      key: `${m.thread_id}:${m.id}`,
      bot: m.bot_name,
      label: m.subject ? `${m.type} on ${m.subject}` : m.type,
      meta: `${m.thread_id.slice(0, 8)}${snap.running.has(m.thread_id) ? " working" : ""}`,
    });
  const more = snap.waiting.length - waitingMax;
  if (more > 0) rows.push({ key: "more-messages", meta: `… ${more} more` });
  if (!snap.waiting.length) rows.push({ key: "none-messages", meta: "none" });

  for (const sec of SECTIONS) {
    rows.push({ key: `gap-${sec}` }, { key: `h-${sec}`, heading: { title: TITLES[sec], count: lists[sec].length } });
    for (const id of lists[sec]) {
      const t = snap.threads[id]!;
      const state = threadState(snap, id);
      const age = state === "done" ? `ended ${ago(t.updated_at)}` : ago(t.updated_at);
      const why = state === "limited" || state === "stranded" ? `${state} · ` : "";
      rows.push({
        key: id,
        id,
        bot: botName(snap, t.bot_id),
        state,
        label: threadLabel(snap, id),
        level: levelOf(snap, id),
        meta: `${why}${id.slice(0, 8)} · ${age}${owner(snap, id)}`,
      });
    }
    if (!lists[sec].length) rows.push({ key: `none-${sec}`, meta: "none" });
  }
  return rows;
}

interface ListRowProps {
  row: Row;
  botWidth: number;
  metaWidth: number;
  columns: number;
  selected: boolean;
}

function ListRow({ row, botWidth, metaWidth, columns, selected }: ListRowProps) {
  if (row.heading) {
    const { title, count } = row.heading;
    return (
      <Text wrap="truncate-end">
        <Text color={termColor(MUTED)}>{title.toUpperCase()}</Text> {count}{" "}
        <Text color={termColor(RULE)}>
          {"─".repeat(Math.max(0, columns - title.length - String(count).length - 2))}
        </Text>
      </Text>
    );
  }
  if (row.bot === undefined)
    return (
      <Text color={termColor(DIM)} wrap="truncate-end">
        {row.meta ? `  ${row.meta}` : " "}
      </Text>
    );
  // Done rows are dim all the way across; the selected row is lighter text on a band.
  const done = row.state === "done";
  const text = selected ? termColor(BAND_TEXT) : done ? termColor(DIM) : undefined;
  const muted = termColor(done ? DIM : MUTED);
  return (
    <Box backgroundColor={selected ? termColor(BAND) : undefined}>
      <Box width={2} flexShrink={0}>
        {selected && chalk.level < 2 ? (
          // Without 256 colors the band doesn't show (16 colors make it black), so the selection takes the dot's place.
          <Text>› </Text>
        ) : row.state ? (
          <Dot state={row.state} />
        ) : (
          <Text color={termColor(MUTED)}>○ </Text>
        )}
      </Box>
      <Box width={botWidth} flexShrink={0}>
        <Text color={muted} wrap="truncate-end">
          {row.bot}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color={text} wrap="truncate-end">
          {row.label}
        </Text>
      </Box>
      <Box width={4} flexShrink={0} marginLeft={1}>
        {row.level && <LevelMark level={row.level} color={done ? DIM : undefined} />}
      </Box>
      <Box width={metaWidth} flexShrink={0}>
        <Text color={muted} wrap="truncate-end">
          {row.meta}
        </Text>
      </Box>
    </Box>
  );
}

interface LogViewProps {
  id: string;
  snap: Snapshot;
  readLog: (sessionId: string) => Promise<string>;
  send: (threadId: string, text: string) => Promise<void>;
  end: (threadId: string) => Promise<void>;
  refreshMs: number;
  onBack: () => void;
}

/**
 * A session's transcript. It follows new output until you scroll up, and again once you're back at the end. `m` writes
 * a message to the thread: Enter sends it, Esc drops it. `e` then `y` ends the thread; `e` then any other key keeps it.
 */
function LogView({ id, snap, readLog, send, end, refreshMs, onBack }: LogViewProps) {
  const { exit } = useApp();
  const { rows: height, columns } = useWindowSize();
  const [log, setLog] = useState<string>();
  // undefined: not writing a message.
  const [draft, setDraft] = useState<string>();
  const [sent, setSent] = useState<string>();
  // Whether `e` is waiting for `y`.
  const [ending, setEnding] = useState(false);
  // undefined: pinned to the end.
  const [top, setTop] = useState<number>();
  useEffect(() => poll(() => readLog(id), setLog, refreshMs), [id, readLog, refreshMs]);

  // The harness this runner ran the session on, else its bot's (a thread of another runner); Claude Code's if neither.
  const botId = snap.threads[id]?.bot_id;
  const harness =
    snap.harnesses?.[id] ??
    [...snap.bots.held, ...snap.bots.skipped, ...snap.bots.unleased].find((b) => b.id === botId)?.harness;
  const lines = useMemo(
    () =>
      transcriptLines(log ?? "", harness ?? "claude").flatMap((l) =>
        wrap(l.text, columns).map((text) => ({ text, kind: l.kind })),
      ),
    [log, harness, columns],
  );
  const body = Math.max(1, height - 2);
  const bottom = Math.max(0, lines.length - body);
  const start = Math.min(top ?? bottom, bottom);
  const scroll = (to: number) => setTop(to >= bottom ? undefined : Math.max(0, to));

  const submit = (text: string) => {
    setDraft(undefined);
    if (!text.trim()) return;
    setSent("sending…");
    send(id, text.trim()).then(
      () => setSent("message sent"),
      (err) => setSent(`not sent: ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  const endThread = () => {
    setSent("ending…");
    end(id).then(
      () => setSent("thread ended"),
      (err) => setSent(`not ended: ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  useInput((input, key) => {
    if (ending) {
      setEnding(false);
      if (input === "y") endThread();
      else setSent("end canceled");
    } else if (draft !== undefined) {
      if (key.escape) setDraft(undefined);
      else if (key.return) submit(draft);
      else if (key.backspace || key.delete) setDraft(draft.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setDraft(draft + input);
    } else if (input === "q") exit();
    else if (input === "m") {
      setSent(undefined);
      setDraft("");
    } else if (input === "e") {
      setSent(undefined);
      setEnding(true);
    } else if (key.leftArrow) onBack();
    else if (key.upArrow) scroll(start - 1);
    else if (key.downArrow) scroll(start + 1);
    else if (key.pageUp) scroll(start - body);
    else if (key.pageDown) scroll(start + body);
    else if (key.home) scroll(0);
    else if (key.end) scroll(bottom);
  });

  const thread = snap.threads[id];
  const state = threadState(snap, id);
  const muted = termColor(MUTED);
  const empty = log === undefined ? "Loading…" : "No transcript yet.";
  return (
    <Box flexDirection="column" height={height}>
      <Text wrap="truncate-end">
        <Dot state={state} />
        {thread && <Text color={muted}>{botName(snap, thread.bot_id)} </Text>}
        <Text bold>{threadLabel(snap, id)}</Text> <LevelMark level={levelOf(snap, id)} />
        <Text color={muted}> · {id.slice(0, 8)} · </Text>
        <Text color={state === "done" ? muted : termColor(STATE_COLORS[state].ink)}>{state}</Text>
        <Text color={muted}>{owner(snap, id)}</Text>
      </Text>
      <Box flexDirection="column" height={body} overflow="hidden">
        {lines.length ? (
          lines.slice(start, start + body).map((l, i) => {
            const { color, dimColor } = KIND_STYLE[l.kind];
            return (
              <Text key={start + i} wrap="truncate-end" color={color && termColor(color)} dimColor={dimColor}>
                {l.text}
              </Text>
            );
          })
        ) : (
          <Text dimColor>{empty}</Text>
        )}
      </Box>
      {draft !== undefined ? (
        <Text wrap="truncate-start">
          <Text color={termColor(INDIGO.ink)}>message ❯ </Text>
          {draft}
          <Text inverse> </Text>
          <Text color={muted}> enter send · esc cancel</Text>
        </Text>
      ) : ending ? (
        <Text color={muted} wrap="truncate-end">
          end this thread? y end · any other key keeps it
        </Text>
      ) : (
        <Text color={muted} wrap="truncate-end">
          {sent ? `${sent} · ` : ""}
          {lines.length ? `${start + 1}–${Math.min(start + body, lines.length)} of ${lines.length} · ` : ""}↑↓ PgUp/PgDn
          scroll · m message · e end · ← back · q quit
        </Text>
      )}
    </Box>
  );
}

interface ChatViewProps {
  chat: Chat;
  onSubmit: (text: string) => void;
  onBack: () => void;
}

/**
 * The chat with the manager: a transcript that follows new messages until you scroll up (↑/↓, PgUp/PgDn, Home/End),
 * and a one-line input that is always live, so keys type. Enter sends, ← (or Esc) goes back to the lists, Ctrl-C quits.
 */
function ChatView({ chat, onSubmit, onBack }: ChatViewProps) {
  const { rows: height, columns } = useWindowSize();
  const [draft, setDraft] = useState("");
  // undefined: pinned to the end.
  const [top, setTop] = useState<number>();
  const lines = useMemo(
    () => [
      ...chat.messages.flatMap((m) => {
        const prefix = m.kind === "tool" || m.kind === "error" ? "  " : `${m.from} ❯ `;
        return wrap(`${prefix}${m.text}`, columns).map((text) => ({ text, from: m.from, kind: m.kind }));
      }),
      ...(chat.thinking ? [{ text: "manager ❯ thinking…", from: "manager" as const, kind: "tool" as const }] : []),
    ],
    [chat, columns],
  );
  const body = Math.max(1, height - 2);
  const bottom = Math.max(0, lines.length - body);
  const start = Math.min(top ?? bottom, bottom);
  const scroll = (to: number) => setTop(to >= bottom ? undefined : Math.max(0, to));

  useInput((input, key) => {
    if (key.escape || key.leftArrow) onBack();
    else if (key.return) {
      onSubmit(draft);
      setDraft("");
      setTop(undefined);
    } else if (key.backspace || key.delete) setDraft(draft.slice(0, -1));
    else if (key.upArrow) scroll(start - 1);
    else if (key.downArrow) scroll(start + 1);
    else if (key.pageUp) scroll(start - body);
    else if (key.pageDown) scroll(start + body);
    else if (key.home) scroll(0);
    else if (key.end) scroll(bottom);
    else if (input && !key.ctrl && !key.meta) setDraft(draft + input);
  });

  const muted = termColor(MUTED);
  return (
    <Box flexDirection="column" height={height}>
      <Text wrap="truncate-end">
        <Text bold>CHAT</Text>
        <Text color={muted}> · manager</Text>
      </Text>
      <Box flexDirection="column" height={body} overflow="hidden">
        {lines.length ? (
          lines.slice(start, start + body).map((l, i) => (
            <Text key={start + i} wrap="truncate-end" {...lineStyle(l)}>
              {l.text}
            </Text>
          ))
        ) : (
          <Text dimColor>Say something to the manager.</Text>
        )}
      </Box>
      <Text wrap="truncate-start">
        <Text color={termColor(INDIGO.ink)}>you ❯ </Text>
        {draft}
        <Text inverse> </Text>
        <Text color={muted}> enter send · ← lists · ctrl-c quit</Text>
      </Text>
    </Box>
  );
}

/** How a line of the chat looks: you in the terminal's color, the manager in indigo, its tools dim and its errors red. */
function lineStyle(l: { from: string; kind?: string }): { color?: string; dimColor?: boolean } {
  if (l.kind === "error") return KIND_STYLE.error;
  if (l.kind === "tool") return { dimColor: true };
  return l.from === "you" ? {} : { color: termColor(INDIGO.ink) };
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
