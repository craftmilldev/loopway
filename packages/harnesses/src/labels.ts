/**
 * The name each harness goes by where people read it (the site, the dashboard), keyed by its `name` and in
 * HARNESSES order. Kept apart from the harnesses themselves so the browser can import it without their node code;
 * the package exports it as `@loopway/harnesses/labels`.
 */
export const HARNESS_LABELS = {
  claude: "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  hermes: "Hermes",
} as const;
