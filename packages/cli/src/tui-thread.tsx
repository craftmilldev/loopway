import { Box, Text, useInput, useWindowSize } from "ink";
import { useState, type ReactNode } from "react";
import { askLabel, openAsks } from "./asks.js";
import { stamp } from "./format.js";
import type { Thread } from "./thread.js";
import { lastOf, sessionColor, sessionText } from "./tui-text.js";

const LISTED = 5;
const MIN_LOG_ROWS = 3;

export interface ThreadViewProps {
  thread: Thread;
  /** The session log so far. */
  log: string;
  onBack: () => void;
  /** Filters the main view to the threads holding this subject. */
  onFilter: (subject: string) => void;
}

/**
 * One thread: its subjects, session status, pending updates, sent messages and session log. ↑/↓ selects a subject and
 * Enter filters the main view to it. The log follows new output until PgUp/PgDn/Home scroll it, and End follows again.
 * ← or Esc goes back.
 */
export function ThreadView({ thread, log, onBack, onFilter }: ThreadViewProps) {
  const [subject, setSubject] = useState(0);
  const open = openAsks(thread);
  const asks = lastOf(open, LISTED);
  const pending = lastOf(thread.queue, LISTED);
  const sent = lastOf(thread.sent ?? [], LISTED);
  const lines = log.split("\n").filter((line, i, all) => line !== "" || i < all.length - 1);
  const { rows } = useWindowSize();
  const logRows = Math.max(MIN_LOG_ROWS, rows - listedRows(thread, asks, pending, sent) - 3);
  const [top, scrollLog] = useScroll(lines.length, logRows);
  const first = top ?? Math.max(0, lines.length - logRows);

  useInput((_input, key) => {
    if (key.escape || key.leftArrow) onBack();
    if (key.upArrow) setSubject(Math.max(0, subject - 1));
    if (key.downArrow) setSubject(Math.min(thread.subjects.length - 1, subject + 1));
    if (key.return) onFilter(thread.subjects[subject]!.key);
    scrollLog(key);
  });

  return (
    <Box flexDirection="column">
      <Text bold>
        {thread.bot} {thread.id} · {thread.status} · created {stamp(thread.createdAt)}
      </Text>
      <Text wrap="truncate-end">
        session <Text color={sessionColor(thread)}>{sessionText(thread)}</Text>
        {thread.session?.lastRunAt && ` · last run ${stamp(thread.session.lastRunAt)}`}
        {thread.session?.lastError && ` · ${thread.session.lastError}`}
      </Text>
      <Section title="Subjects">
        {thread.subjects.map((s, i) => (
          <Text key={s.key} inverse={i === subject} dimColor={s.status === "closed"}>
            {i === subject ? "▸ " : "  "}
            {s.key} {s.status}
          </Text>
        ))}
      </Section>
      <Section title={`Waiting on (${open.length})`} hidden={asks.hidden} empty={asks.shown.length === 0}>
        {asks.shown.map((a) => (
          <Text key={a.id} wrap="truncate-end" color="yellow">
            {"  "}
            {stamp(a.at)} {a.kind} {a.commentUrl} {askLabel(a)}
          </Text>
        ))}
      </Section>
      <Section title={`Pending (${thread.queue.length})`} hidden={pending.hidden} empty={pending.shown.length === 0}>
        {pending.shown.map((p) => (
          <Text key={p.id} wrap="truncate-end">
            {"  "}
            {stamp(p.at)} {p.kind} {p.subject} by {p.actor}
          </Text>
        ))}
      </Section>
      <Section title={`Sent (${thread.sent?.length ?? 0})`} hidden={sent.hidden} empty={sent.shown.length === 0}>
        {sent.shown.map((m) => (
          <Text key={m.at + m.url} wrap="truncate-end">
            {"  "}
            {stamp(m.at)} {m.kind} {m.subject} {m.url}
          </Text>
        ))}
      </Section>
      <Text bold>Session log{top === undefined ? "" : " (scrolled, End follows)"}</Text>
      <Box flexDirection="column" height={logRows} overflow="hidden">
        {lines.length === 0 && <Text dimColor>no log yet</Text>}
        {lines.slice(first, first + logRows).map((line, i) => (
          <Text key={first + i} wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
      <Text dimColor>↑/↓ subject · enter filter by it · pgup/pgdn scroll log · ← back · q quit</Text>
    </Box>
  );
}

function Section(props: { title: string; hidden?: number; empty?: boolean; children: ReactNode }) {
  return (
    <Box flexDirection="column">
      <Text bold>
        {props.title}
        {props.hidden ? <Text dimColor> · {props.hidden} earlier not shown</Text> : null}
      </Text>
      {props.empty ? <Text dimColor>{"  "}none</Text> : props.children}
    </Box>
  );
}

/** Rows everything above the log takes, so the log gets the rest of the screen. */
function listedRows(thread: Thread, ...lists: { shown: unknown[] }[]): number {
  const header = 2;
  const subjects = 1 + thread.subjects.length;
  const sections = lists.reduce((rows, list) => rows + 1 + Math.max(1, list.shown.length), 0);
  return header + subjects + sections;
}

/**
 * Where the log's window starts: undefined follows the end. PgUp, PgDn and Home scroll it, and End (or scrolling
 * down to the end) follows again.
 */
function useScroll(total: number, rows: number) {
  const [top, setTop] = useState<number>();
  const last = Math.max(0, total - rows);
  const scrollTo = (to: number) => setTop(to >= last ? undefined : Math.max(0, to));
  const scroll = (key: { pageUp: boolean; pageDown: boolean; home: boolean; end: boolean }) => {
    const at = Math.min(top ?? last, last);
    if (key.pageUp) scrollTo(at - rows);
    if (key.pageDown) scrollTo(at + rows);
    if (key.home) scrollTo(0);
    if (key.end) scrollTo(last);
  };
  return [top === undefined ? undefined : Math.min(top, last), scroll] as const;
}
