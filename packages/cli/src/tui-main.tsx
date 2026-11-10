import { Box, Text, useInput } from "ink";
import { stamp, subjectKeys } from "./format.js";
import type { Thread } from "./thread.js";
import { sessionColor, sessionText } from "./tui-text.js";

export interface MainViewProps {
  /** The rows, in order: open threads, then the recently closed. */
  threads: Thread[];
  selectedId: string | undefined;
  /** A subject the rows are filtered to. */
  filter: string | undefined;
  /** The latest thing the poller said. */
  latest: string;
  now: number;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onClearFilter: () => void;
}

/** The threads, one row each. ↑/↓ moves, Enter or → opens one, Esc clears the subject filter. */
export function MainView(props: MainViewProps) {
  const { threads, filter, latest } = props;
  const selected = threads.find((t) => t.id === props.selectedId) ?? threads[0];
  useInput((_input, key) => {
    if (key.escape) props.onClearFilter();
    if (!selected) return;
    const at = threads.indexOf(selected);
    if (key.upArrow && at > 0) props.onSelect(threads[at - 1]!.id);
    if (key.downArrow && at < threads.length - 1) props.onSelect(threads[at + 1]!.id);
    if (key.return || key.rightArrow) props.onOpen(selected.id);
  });

  return (
    <Box flexDirection="column">
      <Text bold>
        loopway · {threads.length} threads
        {filter && <Text color="cyan"> · filter {filter} (esc clears)</Text>}
      </Text>
      {threads.length === 0 && <Text dimColor>No threads yet.</Text>}
      {threads.map((t) => (
        <Row key={t.id} thread={t} selected={t === selected} />
      ))}
      <Text dimColor wrap="truncate-end">
        {latest || "waiting for the poller"}
      </Text>
      <Text dimColor>↑/↓ move · enter open · esc clear filter · q quit</Text>
    </Box>
  );
}

/** bot, subjects, thread status, session status, pending count, time of the latest message. Closed threads are dim. */
function Row({ thread, selected }: { thread: Thread; selected: boolean }) {
  const closed = thread.status === "closed";
  return (
    <Text wrap="truncate-end" dimColor={closed} inverse={selected}>
      {selected ? "▸ " : "  "}
      {thread.bot.padEnd(8)} {thread.status.padEnd(6)}{" "}
      <Text color={sessionColor(thread)}>{sessionText(thread).padEnd(14)}</Text>
      {"  "}
      {thread.queue.length} pending {stamp(thread.latestAt)} {subjectKeys(thread)}
    </Text>
  );
}
