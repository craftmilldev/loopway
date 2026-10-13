import type { BotActivity } from "./lw.js";

/** Small bars, one per day, for a bot's deliveries. Words instead for a bot with none in the window. */
export function DeliveryBars({ activity, days = 14 }: { activity: BotActivity | undefined; days?: number }) {
  if (!activity) return <span className="muted">…</span>;
  const shown = activity.days.slice(-days);
  const total = shown.reduce((n, d) => n + d.delivered, 0);
  if (!total) return <span className="muted">No deliveries</span>;
  const max = Math.max(...shown.map((d) => d.delivered));
  return (
    <span className="bars" role="img" aria-label={`${total} delivered in ${shown.length} days`}>
      {shown.map((d) => (
        <span
          key={d.date}
          className="bar"
          title={`${d.date}: ${d.delivered}`}
          style={{ height: d.delivered ? Math.max(2, Math.round((d.delivered / max) * 20)) : 1 }}
        />
      ))}
    </span>
  );
}
