/** loopway's colors, taken from the billboard on the marketing page, so the TUI looks like the same place. */
export const theme = {
  /** The sign's letters: loopway's own red, and the cream it's painted on. */
  red: "#e92f12",
  madder: "#9e2b1c",
  cream: "#f3ecd9",
  /** The sky blue: work in progress. */
  blue: "#4a7991",
  /** The grass: things that went well. */
  green: "#7c9a69",
  /** The land: things that need the owner. */
  land: "#b9b58a",
  ink: "#16130e",
};

/** The colors of a session's state, on the main view and in the thread view. */
export const stateColors = {
  running: theme.blue,
  blocked: theme.land,
  failed: theme.red,
  idle: theme.green,
} as const;
