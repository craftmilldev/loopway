/**
 * One color in its two grounds: `paper` on the light ground of the dashboard and the site, `ink` on a dark one
 * (the terminal, an ink panel), where the paper step doesn't have the contrast to read. Both are steps of one ramp.
 */
export interface Tone {
  paper: string;
  ink: string;
}

/** indigo-600 on paper, indigo-200 on ink. */
export const INDIGO: Tone = { paper: "#2c4a53", ink: "#9db4ba" };
/** madder-600 on paper, madder-300 on ink. */
export const MADDER: Tone = { paper: "#9e2b1c", ink: "#d08a76" };
/** ink-500 on paper, ink-200 on ink. */
export const INK: Tone = { paper: "#5c5544", ink: "#a9a28c" };
/** ink-300 on either ground. */
export const FAINT: Tone = { paper: "#8b8471", ink: "#8b8471" };

export type State = "working" | "limited" | "stranded" | "waiting" | "idle";

/** The color of each state, for its badge (`.state`) and its dot (`.dot`). */
export const STATE_COLORS: Record<State, Tone> = {
  working: INDIGO,
  limited: MADDER,
  stranded: MADDER,
  waiting: INK,
  idle: INK,
};

export type Level = 2 | 3 | 4;

/** The color of each automation level, for the level pie and a thread's `L2`/`L3`/`L4`. */
export const LEVEL_COLORS: Record<Level, Tone> = { 2: FAINT, 3: INDIGO, 4: MADDER };
