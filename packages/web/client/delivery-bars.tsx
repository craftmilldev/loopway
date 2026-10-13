import { useState } from "react";
import type { BotActivity } from "./lw.js";

/** The days of deliveries the bars show. */
export const BAR_DAYS = 14;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-12" as "Oct 12". */
function shortDate(date: string): string {
  const [, m, d] = date.split("-");
  const month = MONTHS[Number(m) - 1];
  return month ? `${month} ${Number(d)}` : date;
}

/** Where the tooltip sits: above the hovered column, in viewport coordinates so no scroll box clips it. */
interface Tip {
  text: string;
  x: number;
  y: number;
}

/** Small bars, one per day, for a bot's deliveries. Words instead for a bot with none in the window. */
export function DeliveryBars({ activity, days }: { activity: BotActivity | undefined; days: number }) {
  const [tip, setTip] = useState<Tip | null>(null);
  if (!activity) return <span className="muted">…</span>;
  const shown = activity.days.slice(-days);
  const total = shown.reduce((n, d) => n + d.delivered, 0);
  if (!total) return <span className="muted">No deliveries</span>;
  const max = Math.max(...shown.map((d) => d.delivered));
  const show = (el: HTMLElement, text: string) => {
    const r = el.getBoundingClientRect();
    setTip({ text, x: r.left + r.width / 2, y: r.top });
  };
  return (
    <span className="bars-wrap" role="group" aria-label={`${total} delivered in ${shown.length} days`}>
      <span className="bars">
        {shown.map((d) => {
          const text = `${shortDate(d.date)} · ${d.delivered} delivered`;
          return (
            <span
              key={d.date}
              className="bar-col"
              role="img"
              aria-label={text}
              tabIndex={0}
              onMouseEnter={(e) => show(e.currentTarget, text)}
              onFocus={(e) => show(e.currentTarget, text)}
              onMouseLeave={() => setTip(null)}
              onBlur={() => setTip(null)}
            >
              <span
                className="bar"
                style={{ height: d.delivered ? Math.max(2, Math.round((d.delivered / max) * 20)) : 1 }}
              />
            </span>
          );
        })}
      </span>
      <span className="bars-max" aria-hidden="true">
        max {max}
      </span>
      {tip && (
        <span className="bar-tip" aria-hidden="true" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </span>
      )}
    </span>
  );
}
