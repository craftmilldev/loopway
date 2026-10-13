/** The messages all `activities` delivered over their last `days` days. */
export function deliveredIn(activities: { days: { delivered: number }[] }[], days: number) {
  return activities.reduce((n, a) => n + a.days.slice(-days).reduce((m, d) => m + d.delivered, 0), 0);
}
