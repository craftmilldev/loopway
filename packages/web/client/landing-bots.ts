import type { BotRow } from "./bots-table.js";
import { BAR_DAYS } from "./delivery-bars.js";

// The sample bots in the landing page's dashboard figure. Made up, so none of them is one of ours. Together they
// show every state and every level.

/** The last day the bars show, as the figure's "today". */
const LAST_DAY = Date.UTC(2026, 9, 15);

const days = (counts: number[]) =>
  counts.map((delivered, i) => ({
    date: new Date(LAST_DAY - (BAR_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    delivered,
  }));

export const SAMPLE_BOTS: BotRow[] = [
  {
    id: "intake",
    name: "intake",
    detail: "Claude Code",
    state: "working",
    reason: "2 messages in flight",
    reads: "loopway",
    runner: "studio-mac",
    open: 4,
    waiting: 2,
    activity: { days: days([3, 5, 2, 0, 0, 6, 4, 7, 4, 3, 0, 5, 8, 6]), levels: { 2: 4, 3: 2, 4: 0 } },
    last: "2 min ago",
  },
  {
    id: "issue-to-pr",
    name: "issue-to-pr",
    detail: "Claude Code",
    state: "working",
    reason: "1 message in flight",
    reads: "GitHub",
    runner: "studio-mac",
    open: 3,
    waiting: 1,
    activity: { days: days([4, 7, 3, 0, 0, 9, 6, 10, 6, 4, 0, 7, 11, 8]), levels: { 2: 1, 3: 6, 4: 3 } },
    last: "1 min ago",
  },
  {
    id: "second-look",
    name: "second-look",
    detail: "Codex",
    state: "limited",
    reason: "Hit its usage limit",
    reads: "GitHub",
    runner: "studio-mac",
    open: 2,
    waiting: 3,
    activity: { days: days([2, 4, 3, 0, 0, 5, 4, 6, 5, 3, 0, 4, 7, 2]), levels: { 2: 0, 3: 2, 4: 8 } },
    last: "41 min ago",
  },
  {
    id: "deploy-medic",
    name: "deploy-medic",
    detail: "Cursor",
    state: "stranded",
    reason: "Its runner is offline",
    reads: "Vercel",
    runner: "build-box",
    open: 1,
    waiting: 1,
    activity: { days: days([0, 1, 0, 0, 2, 0, 1, 0, 0, 1, 0, 0, 1, 0]), levels: { 2: 0, 3: 1, 4: 4 } },
    last: "3 h ago",
  },
  {
    id: "backlog-sweep",
    name: "backlog-sweep",
    detail: "Codex",
    state: "waiting",
    reason: "Waiting for a runner",
    reads: "Linear, a daily schedule",
    runner: null,
    open: 1,
    waiting: 0,
    activity: { days: days([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), levels: { 2: 0, 3: 0, 4: 5 } },
    last: "1 d ago",
  },
  {
    id: "notes-to-tasks",
    name: "notes-to-tasks",
    detail: "Hermes",
    state: "idle",
    reason: "",
    reads: "Granola",
    runner: "studio-mac",
    open: 0,
    waiting: 0,
    activity: { days: days([0, 2, 0, 0, 1, 0, 0, 3, 0, 1, 0, 0, 2, 0]), levels: { 2: 3, 3: 2, 4: 0 } },
    last: "2 d ago",
  },
  {
    id: "bounce-check",
    name: "bounce-check",
    detail: "Hermes",
    state: "idle",
    reason: "",
    reads: "Resend",
    runner: "studio-mac",
    open: 0,
    waiting: 0,
    activity: { days: days([0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0]), levels: { 2: 0, 3: 1, 4: 3 } },
    last: "4 d ago",
  },
];
