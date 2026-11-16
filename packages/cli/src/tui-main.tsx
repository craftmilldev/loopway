import { Box, Text, useInput, useWindowSize } from "ink";
import { stamp, subjectKeys } from "./format.js";
import type { Thread } from "./thread.js";
import { Footer, Header, HEADER_ROWS } from "./tui-header.js";
import { groupThreads, sessionColor, sessionText } from "./tui-text.js";
import { theme } from "./tui-theme.js";

export interface MainViewProps {
  /** The rows: open threads, then the recently closed. */
  threads: Thread[];
  version: string;
  selectedId: string | undefined;
  /** A subject the rows are filtered to. */
  filter: string | undefined;
  /** The latest thing the poller said. */
  latest: string;
  /** What the poller is doing: last checked, next check. */
  status: string;
  now: number;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onClearFilter: () => void;
  onRefresh: () => void;
}

type Item = { type: "heading"; title: string; color: string; count: number } | { type: "thread"; thread: Thread };

/**
 * The threads under headings: the open ones by state (what needs you first), then the closed. ↑/↓ moves through them
 * in the order shown, Enter or → opens one, r polls GitHub now, Esc clears the subject filter. The header and the keys
 * stay at the top and bottom of the screen.
 */
export function MainView(props: MainViewProps) {
  const { filter, latest, status, version } = props;
  const groups = groupThreads(props.threads);
  const ordered = groups.flatMap((g) => g.threads);
  const selected = ordered.find((t) => t.id === props.selectedId) ?? ordered[0];
  useInput((input, key) => {
    if (input === "r") props.onRefresh();
    if (key.escape) props.onClearFilter();
    if (!selected) return;
    const at = ordered.indexOf(selected);
    if (key.upArrow && at > 0) props.onSelect(ordered[at - 1]!.id);
    if (key.downArrow && at < ordered.length - 1) props.onSelect(ordered[at + 1]!.id);
    if (key.return || key.rightArrow) props.onOpen(selected.id);
  });

  const { rows } = useWindowSize();
  const items: Item[] = groups.flatMap((g) => [
    { type: "heading" as const, title: g.title, color: g.color, count: g.threads.length },
    ...g.threads.map((thread) => ({ type: "thread" as const, thread })),
  ]);
  const room = Math.max(3, rows - HEADER_ROWS - 1 - (latest ? 1 : 0));
  const at = items.findIndex((i) => i.type === "thread" && i.thread === selected);
  // Keep the selected row on screen, with its heading when the window starts there.
  const first = at < room ? 0 : at - room + 1;

  return (
    <Box flexDirection="column" height={rows}>
      <Header version={version} status={status}>
        <Text color={theme.cream}> · {props.threads.length} threads</Text>
        {filter && <Text color={theme.blue}> · filter {filter} (esc clears)</Text>}
      </Header>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {items.length === 0 && <Text dimColor>No threads yet.</Text>}
        {items.slice(first, first + room).map((item) =>
          item.type === "heading" ? (
            <Text key={item.title} bold color={item.color}>
              {item.title} <Text dimColor>{item.count}</Text>
            </Text>
          ) : (
            <Row key={item.thread.id} thread={item.thread} selected={item.thread === selected} />
          ),
        )}
      </Box>
      {latest && (
        <Text dimColor wrap="truncate-end">
          {latest}
        </Text>
      )}
      <Footer
        keys={[
          ["↑/↓", "move"],
          ["enter", "open"],
          ["r", "refresh"],
          ["esc", "clear filter"],
          ["q", "quit"],
        ]}
      />
    </Box>
  );
}

/** bot, session status, pending count, time of the latest message, subjects. Closed threads are dim. */
function Row({ thread, selected }: { thread: Thread; selected: boolean }) {
  const closed = thread.status === "closed";
  return (
    <Text
      wrap="truncate-end"
      dimColor={closed}
      backgroundColor={selected ? theme.madder : undefined}
      color={selected ? theme.cream : undefined}
    >
      {selected ? "▸ " : "  "}
      <Text bold>{thread.bot.padEnd(8)}</Text>{" "}
      <Text color={selected ? theme.cream : sessionColor(thread)}>{sessionText(thread).padEnd(14)}</Text>
      {"  "}
      {thread.queue.length} pending {stamp(thread.latestAt)} {subjectKeys(thread)}
    </Text>
  );
}
