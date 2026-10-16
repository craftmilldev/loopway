import { LEVEL_COLORS } from "@loopway/palette";

/** The automation levels a thread can be at, with the slice color for each. */
const LEVELS = ([2, 3, 4] as const).map((level) => ({ level, color: LEVEL_COLORS[level].paper }));

/** A pie of the share of a bot's threads at each automation level. Words for a bot with no threads. */
export function LevelPie({
  levels,
  size = 24,
}: {
  levels: { 2: number; 3: number; 4: number } | undefined;
  /** The pie's diameter in px. */
  size?: number;
}) {
  if (!levels) return <span className="muted">…</span>;
  const total = levels[2] + levels[3] + levels[4];
  if (!total) return <span className="muted">No threads</span>;
  const r = size / 2;
  const text = LEVELS.map(({ level }) => `${Math.round((levels[level] / total) * 100)}% level ${level}`).join(", ");
  let start = 0;
  const slices = LEVELS.filter(({ level }) => levels[level]).map(({ level, color }) => {
    const share = levels[level] / total;
    if (share === 1) return <circle key={level} cx={r} cy={r} r={r} fill={color} />;
    const a0 = start * 2 * Math.PI;
    const a1 = (start + share) * 2 * Math.PI;
    start += share;
    const pt = (a: number) => `${r + r * Math.sin(a)} ${r - r * Math.cos(a)}`;
    return (
      <path key={level} d={`M${r} ${r} L${pt(a0)} A${r} ${r} 0 ${share > 0.5 ? 1 : 0} 1 ${pt(a1)} Z`} fill={color} />
    );
  });
  return (
    <span className="level-pie">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={text}>
        <title>{text}</title>
        {slices}
      </svg>
      {size > 24 && (
        <ul className="level-key">
          {LEVELS.map(({ level, color }) => (
            <li key={level}>
              <span className="swatch" style={{ background: color }} />
              Level {level} · {levels[level]}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
