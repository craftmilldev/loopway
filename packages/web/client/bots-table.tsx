import type { BotState } from "./bot-state.js";
import { BAR_DAYS, DeliveryBars } from "./delivery-bars.js";
import { LevelPie } from "./level-pie.js";
import type { BotActivity } from "./lw.js";
import { StateBadge } from "./overview.js";

/** One line of the bots table. The dashboard fills it from the API; the landing page fills it with samples. */
export interface BotRow {
  id: string;
  name: string;
  /** Where the name links to. Without it the name is plain text. */
  href?: string;
  /** The small line under the name. */
  detail: string;
  state: BotState;
  /** One line under the state badge on why the bot is in it. */
  reason: string;
  /** The inboxes it reads, as text. */
  reads: string;
  open: number;
  waiting: number;
  /** Its deliveries and levels; undefined while they load. */
  activity: Pick<BotActivity, "days" | "levels"> | undefined;
  /** When its last delivery was, as words; null when it has none, undefined while that loads. */
  last: string | null | undefined;
}

/** The bots table: a state, deliveries and levels for each bot. Scrolls sideways inside its own box. */
export function BotsTable({ rows }: { rows: BotRow[] }) {
  return (
    <div className="scroll">
      <table className="ledger bots-ledger">
        <thead>
          <tr>
            <th scope="col">Bot</th>
            <th scope="col">State</th>
            <th scope="col">Reads</th>
            <th scope="col" className="num">
              Open threads
            </th>
            <th scope="col" className="num">
              Messages waiting
            </th>
            <th scope="col">Deliveries, {BAR_DAYS} days</th>
            <th scope="col">Levels</th>
            <th scope="col" className="num">
              Last delivery
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.href ? (
                  <a className="bot-link" href={r.href}>
                    {r.name}
                  </a>
                ) : (
                  <span className="bot-link">{r.name}</span>
                )}
                <div className="lbl small">{r.detail}</div>
              </td>
              <td>
                <StateBadge state={r.state} />
                {r.reason && <div className="why">{r.reason}</div>}
              </td>
              <td className="mono">{r.reads}</td>
              <td className="num">{r.open}</td>
              <td className="num">{r.waiting}</td>
              <td>
                <DeliveryBars activity={r.activity} days={BAR_DAYS} />
              </td>
              <td>
                <LevelPie levels={r.activity?.levels} />
              </td>
              <td className={"num" + (r.last ? "" : " muted")}>{r.last === undefined ? "…" : (r.last ?? "never")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
