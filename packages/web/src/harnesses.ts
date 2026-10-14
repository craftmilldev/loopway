/** The harnesses a bot's sessions can run in. A harness not listed here can be requested (see ee/). */
export const HARNESSES = [{ id: "claude-code", label: "Claude Code" }] as const;

export const DEFAULT_HARNESS = HARNESSES[0].id;
