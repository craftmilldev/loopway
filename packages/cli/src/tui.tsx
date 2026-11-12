import { Box, render, useApp, useInput } from "ink";
import { useEffect, useReducer, useState } from "react";
import type { Thread } from "./thread.js";
import { visibleThreads, withSubject } from "./threads.js";
import { MainView } from "./tui-main.js";
import { ThreadView } from "./tui-thread.js";

export interface TuiProps {
  /** The threads, as the poller's store holds them right now. */
  threads: () => Thread[];
  /** What a thread's session has logged so far. */
  readLog: (threadId: string) => string;
  /** The latest thing the poller said. */
  latest: () => string;
  /** What the poller is doing, as a line: when it last checked and when it will next. */
  status: (now: number) => string;
  /** Polls GitHub now, instead of waiting for the poller's timers. */
  onRefresh: () => void;
  /** Chat with a thread's session, when there are sessions. */
  chat?: { send: (threadId: string, text: string) => void; end: (threadId: string) => void };
  now?: () => number;
  refreshMs?: number;
}

/** Runs the TUI full-screen until the user quits. */
export async function showTui(props: TuiProps): Promise<void> {
  const app = render(<Tui {...props} />, { alternateScreen: true });
  await app.waitUntilExit();
}

/** The main view of threads, and the view of one thread. q quits; Ctrl-C does too. */
export function Tui({ threads, readLog, latest, status, onRefresh, chat, now = Date.now, refreshMs = 1000 }: TuiProps) {
  const { exit } = useApp();
  const [filter, setFilter] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [openId, setOpenId] = useState<string>();
  /** The thread being chatted with: typing `q` there is a letter, not quit. */
  const [chatId, setChatId] = useState<string>();
  useRefresh(refreshMs);
  useInput((input) => {
    if (input === "q" && !chatId) exit();
  });

  const all = threads();
  const open = all.find((t) => t.id === openId);
  if (open) {
    return (
      <ThreadView
        thread={open}
        log={readLog(open.id)}
        onBack={() => setOpenId(undefined)}
        chat={
          chat && {
            active: chatId === open.id,
            onStart: () => setChatId(open.id),
            onSend: (text) => chat.send(open.id, text),
            onEnd: () => {
              chat.end(open.id);
              setChatId(undefined);
            },
          }
        }
        onFilter={(subject) => {
          setFilter(subject);
          setOpenId(undefined);
        }}
      />
    );
  }
  const shown = visibleThreads(filter ? withSubject(all, filter) : all, now());
  return (
    <Box flexDirection="column">
      <MainView
        threads={shown}
        selectedId={selectedId}
        filter={filter}
        latest={latest()}
        status={status(now())}
        now={now()}
        onSelect={setSelectedId}
        onOpen={setOpenId}
        onClearFilter={() => setFilter(undefined)}
        onRefresh={onRefresh}
      />
    </Box>
  );
}

/** Renders again every `ms`, so the views show what the poller and the sessions have done since. */
function useRefresh(ms: number) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = setInterval(refresh, ms);
    return () => clearInterval(timer);
  }, [ms]);
}
