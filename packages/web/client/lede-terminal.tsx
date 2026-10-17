import { LEVEL_COLORS, STATE_COLORS, type Level, type State } from "@loopway/palette";
import type { ReactNode } from "react";

/**
 * The lede's figure: `loopway bots run` holding three bots, drawn the way the TUI (cli/src/bots/tui.tsx) lists them.
 * A static picture with made-up bots and threads; it runs nothing.
 */

interface Row {
  bot: string;
  /** undefined: a waiting message, which gets a ring. */
  state?: State | "done";
  label: string;
  level?: Level;
  meta: string;
  selected?: boolean;
}

const MESSAGES: Row[] = [{ bot: "deploy-medic", label: "deployment.error on #241", meta: "01a1f3c2" }];

const LISTS: { title: string; rows: Row[] }[] = [
  {
    title: "Working",
    rows: [
      {
        bot: "issue-to-pr",
        state: "working",
        label: "#306 Add a retry to the webhook sender",
        level: 4,
        meta: "01a1f0b7 · 4m",
        selected: true,
      },
      {
        bot: "second-look",
        state: "working",
        label: "#309 Add a retry to the webhook sender",
        level: 4,
        meta: "01a1f0e4 · 1m",
      },
    ],
  },
  {
    title: "Waiting",
    rows: [
      {
        bot: "deploy-medic",
        state: "waiting",
        label: "#241 Production deploy failed at build",
        level: 3,
        meta: "01a1ee90 · asked you 13:14",
      },
      {
        bot: "issue-to-pr",
        state: "waiting",
        label: "#235 Let a team share one webhook",
        level: 2,
        meta: "01a1ea35 · review requested",
      },
    ],
  },
  {
    title: "Done",
    rows: [
      {
        bot: "issue-to-pr",
        state: "done",
        label: "#307 Fix the date in the export header",
        level: 3,
        meta: "01a1d2f8 · ended 11:02",
      },
      {
        bot: "second-look",
        state: "done",
        label: "#308 Fix the date in the export header",
        level: 4,
        meta: "01a1d2c1 · ended 10:47",
      },
    ],
  },
];

const Dot = ({ state }: { state?: State | "done" }) =>
  state === undefined ? (
    <span className="lt-mark">○</span>
  ) : state === "done" ? (
    <span />
  ) : (
    <span className="lt-mark" style={{ color: STATE_COLORS[state].ink }}>
      ●
    </span>
  );

function Heading({ title, count }: { title: string; count: number }) {
  return (
    <div className="lt-heading">
      {title.toUpperCase()} <b>{count}</b>
    </div>
  );
}

function Rows({ rows }: { rows: Row[] }) {
  return (
    <div className="lt-rows">
      {rows.map((r) => (
        <div
          key={r.bot + r.label}
          className={`lt-row${r.state === "done" ? " lt-done" : ""}${r.selected ? " lt-selected" : ""}`}
        >
          <Dot state={r.state} />
          <span className="lt-bot">{r.bot}</span>
          <span className="lt-label">{r.label}</span>
          <span
            className="lt-level"
            style={r.level && r.state !== "done" ? { color: LEVEL_COLORS[r.level].ink } : undefined}
          >
            {r.level ? `L${r.level}` : ""}
          </span>
          <span className="lt-meta">{r.meta}</span>
        </div>
      ))}
    </div>
  );
}

export function LedeTerminal(): ReactNode {
  return (
    <figure className="lt">
      <div className="lt-screen">
        <div className="lt-bar">
          <span>~/code/loopway</span>
          <span>loopway bots run --max 3</span>
        </div>
        <div className="lt-body">
          <div>
            <div className="lt-title">
              <b>LOOPWAY</b> · runner mw-studio · org craftmill
            </div>
            <div className="lt-muted">
              holds issue-to-pr, second-look, deploy-medic · skipped backlog-sweep, held by mw-air until 14:32
            </div>
          </div>
          <div>
            <Heading title="Waiting messages" count={MESSAGES.length} />
            <Rows rows={MESSAGES} />
          </div>
          {LISTS.map((l) => (
            <div key={l.title}>
              <Heading title={l.title} count={l.title === "Done" ? 31 : l.rows.length} />
              <Rows rows={l.rows} />
            </div>
          ))}
          <div className="lt-status">
            <span>14:21:07 delivered 1 message to deploy-medic</span>
            <span>↑↓ move · tab next list · enter/→ open · q quit</span>
          </div>
        </div>
      </div>
      <figcaption className="lt-caption">One runner holding three bots. Sample data.</figcaption>
    </figure>
  );
}
