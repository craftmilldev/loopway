import chalk from "chalk";

const CUBE = [0, 95, 135, 175, 215, 255];

/**
 * The xterm 256-color palette from 16 on, as [index, r, g, b]: the 6×6×6 cube, then the gray ramp. 0–15 are left out
 * because a terminal's theme decides what they look like.
 */
const XTERM: [number, number, number, number][] = [
  ...Array.from({ length: 216 }, (_, i): [number, number, number, number] => [
    16 + i,
    CUBE[Math.floor(i / 36)]!,
    CUBE[Math.floor(i / 6) % 6]!,
    CUBE[i % 6]!,
  ]),
  ...Array.from({ length: 24 }, (_, i): [number, number, number, number] => [
    232 + i,
    8 + 10 * i,
    8 + 10 * i,
    8 + 10 * i,
  ]),
];

/** The 256-color index closest to `hex` (`#rrggbb`). */
export function nearest256(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  let best = XTERM[0]!;
  let bestDistance = Infinity;
  for (const c of XTERM) {
    const d = (c[1] - r) ** 2 + (c[2] - g) ** 2 + (c[3] - b) ** 2;
    if (d < bestDistance) [best, bestDistance] = [c, d];
  }
  return best[0];
}

/**
 * `hex` for an Ink color prop: as it is where the terminal has truecolor, else the nearest of the 256 colors. (Given
 * a hex, chalk would round each channel on its own, which turns these muted colors into brighter ones.)
 */
export function termColor(hex: string, level: number = chalk.level): string {
  return level >= 3 ? hex : `ansi256(${nearest256(hex)})`;
}

/** What the terminal can show, as chalk (and so Ink) sees it, for metrics. */
export function colorSupport(level: number = chalk.level): "truecolor" | "256" | "16" | "none" {
  return level >= 3 ? "truecolor" : level === 2 ? "256" : level === 1 ? "16" : "none";
}
