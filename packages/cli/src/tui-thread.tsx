import { Box, Text, useInput, useWindowSize } from "ink";
import { useState } from "react";
import { askLabel, openAsks } from "./asks.js";
import { stamp } from "./format.js";
import type { Thread } from "./thread.js";
import { Footer, Header, HEADER_ROWS } from "./tui-header.js";
import { editInput, emptyInput, InputLine, type InputState } from "./tui-input.js";
import { logRows, type LogRow } from "./tui-log.js";
import { lastOf, sessionColor, sessionText } from "./tui-text.js";
import { theme } from "./tui-theme.js";

const LISTED = 5;
const MIN_LOG_ROWS = 3;

export interface ThreadViewProps {
  thread: Thread;
  version: string;
  /** What the poller is doing. */
  status: string;
  /** The session log so far. */
  log: string;
  onBack: () => void;
  /** Filters the main view to the threads holding this subject. */
  onFilter: (subject: string) => void;
  /** Chat with the thread's session. Missing when sessions are off. */
  chat?: {
    /** In a chat block: the keys type a message instead of moving around. */
    active: boolean;
    onStart: () => void;
    onSend: (text: string) => void;
    onEnd: () => void;
  };
}

/**
 * One thread: its subjects, session state, what it is waiting on, counts of updates and messages, and the session log as
 * a block per turn. ↑/↓ scrolls the log (it follows new output until you scroll up, and scrolling down to the end
 * follows again), Tab picks a subject and Enter filters the main view to it. ← or Esc goes back. `c` starts a chat with
 * the session: the line you type works like a text box, Enter sends it, and Esc ends the chat.
 */
export function ThreadView({ thread, version, status, log, onBack, onFilter, chat }: ThreadViewProps) {
  const [subject, setSubject] = useState(0);
  const [draft, setDraft] = useState<InputState>(emptyInput);
  const chatting = chat?.active === true;
  const open = openAsks(thread);
  const asks = lastOf(open, LISTED);
  const rows = logRows(log);
  const { rows: screenRows, columns } = useWindowSize();
  const fixed =
    HEADER_ROWS +
    2 +
    thread.subjects.length +
    (asks.shown.length ? 1 + asks.shown.length : 0) +
    1 +
    (chatting ? 3 : 0) +
    1;
  const logHeight = Math.max(MIN_LOG_ROWS, screenRows - fixed);
  const [top, scrollLog] = useScroll(rows.length, logHeight);
  const first = top ?? Math.max(0, rows.length - logHeight);

  useInput((input, key) => {
    if (chat && chatting) {
      if (key.escape) chat.onEnd();
      else if (key.return) {
        if (draft.value.trim()) chat.onSend(draft.value.trim());
        setDraft(emptyInput);
      } else setDraft(editInput(draft, input, key));
      // Home and End belong to the cursor here: only the keys the line doesn't use scroll the log.
      scrollLog({ ...key, home: false, end: false });
      return;
    }
    if (input === "c" && chat && thread.status === "open") {
      setDraft(emptyInput);
      chat.onStart();
    }
    if (key.escape || key.leftArrow) onBack();
    if (key.tab) setSubject((subject + 1) % thread.subjects.length);
    if (key.return) onFilter(thread.subjects[subject]!.key);
    scrollLog(key);
  });

  const color = sessionColor(thread) ?? theme.green;
  const sent = thread.sent?.length ?? 0;
  return (
    <Box flexDirection="column" height={screenRows}>
      <Header version={version} status={status} />
      <Text wrap="truncate-end">
        <Text bold color={theme.cream}>
          {thread.bot}
        </Text>
        <Text dimColor> {thread.id} · </Text>
        <Text color={thread.status === "open" ? theme.green : theme.land}>{thread.status}</Text>
        <Text dimColor> · session </Text>
        <Text color={color}>● {sessionText(thread)}</Text>
        {thread.session?.lastError && <Text color={theme.red}> · {thread.session.lastError}</Text>}
        {thread.session?.lastRunAt && <Text dimColor> · last run {stamp(thread.session.lastRunAt)}</Text>}
        <Text dimColor> · created {stamp(thread.createdAt)}</Text>
      </Text>
      <Box>
        <Stat n={thread.subjects.length} label="subjects" color={theme.cream} />
        <Stat n={open.length} label="waiting on you" color={open.length ? theme.land : theme.green} />
        <Stat n={thread.queue.length} label="updates queued" color={thread.queue.length ? theme.blue : theme.green} />
        <Stat n={sent} label="messages sent" color={theme.green} />
      </Box>
      {thread.subjects.map((s, i) => (
        <Text key={s.key} wrap="truncate-end" dimColor={s.status === "closed"}>
          <Text color={theme.red}>{i === subject ? "▸ " : "  "}</Text>
          <Text bold={i === subject}>{s.key}</Text> {s.status}
          {s.created && <Text color={theme.blue}> · created by this thread</Text>}
        </Text>
      ))}
      {asks.shown.length > 0 && (
        <Box flexDirection="column">
          <Text bold color={theme.land}>
            Waiting on you ({open.length}){asks.hidden ? ` · ${asks.hidden} earlier not shown` : ""}
          </Text>
          {asks.shown.map((a) => (
            <Text key={a.id} wrap="truncate-end" color={theme.land}>
              {"  "}
              {stamp(a.at)} {a.kind} {a.commentUrl} {askLabel(a)}
            </Text>
          ))}
        </Box>
      )}
      <Text bold color={theme.cream}>
        Session{top === undefined ? "" : <Text color={theme.land}> (scrolled · ↓ to the end follows)</Text>}
      </Text>
      <Box flexDirection="column" height={logHeight} overflow="hidden">
        {rows.length === 0 && <Text dimColor>no log yet</Text>}
        {rows.slice(first, first + logHeight).map((row, i) => (
          <RowLine key={first + i} row={row} />
        ))}
      </Box>
      {chatting && (
        <Box borderStyle="round" borderColor={theme.red} paddingX={1}>
          <Text color={theme.red} bold>
            chat ›{" "}
          </Text>
          <InputLine state={draft} width={columns - 14} />
        </Box>
      )}
      {chatting ? (
        <Footer
          keys={[
            ["enter", "send"],
            ["←/→", "move in the line"],
            ["↑/↓", "scroll"],
            ["esc", "end chat (the session reports to the ticket if it should)"],
          ]}
        />
      ) : (
        <Footer
          keys={[
            ["↑/↓", "scroll"],
            ["tab", "subject"],
            ["enter", "filter by it"],
            ...(chat && thread.status === "open" ? ([["c", "chat"]] as [string, string][]) : []),
            ["←", "back"],
            ["q", "quit"],
          ]}
        />
      )}
    </Box>
  );
}

function Stat({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <Box marginRight={2}>
      <Text backgroundColor={color} color={theme.ink} bold>
        {` ${n} `}
      </Text>
      <Text dimColor> {label}</Text>
    </Box>
  );
}

function RowLine({ row }: { row: LogRow }) {
  return (
    <Text wrap="truncate-end">
      <Text color={row.color}>{row.gutter}</Text>
      {row.parts.map((p, i) => (
        <Text key={i} color={p.color} dimColor={p.dim} bold={p.bold}>
          {p.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * Where the log's window starts: undefined follows the end. ↑/↓ scroll a line, and PgUp, PgDn, Home and End work too,
 * but nothing needs them. Reaching the end follows again.
 */
function useScroll(total: number, rows: number) {
  const [top, setTop] = useState<number>();
  const last = Math.max(0, total - rows);
  const scrollTo = (to: number) => setTop(to >= last ? undefined : Math.max(0, to));
  const scroll = (key: {
    upArrow: boolean;
    downArrow: boolean;
    pageUp: boolean;
    pageDown: boolean;
    home: boolean;
    end: boolean;
  }) => {
    const at = Math.min(top ?? last, last);
    if (key.upArrow) scrollTo(at - 1);
    if (key.downArrow) scrollTo(at + 1);
    if (key.pageUp) scrollTo(at - rows);
    if (key.pageDown) scrollTo(at + rows);
    if (key.home) scrollTo(0);
    if (key.end) scrollTo(last);
  };
  return [top === undefined ? undefined : Math.min(top, last), scroll] as const;
}
