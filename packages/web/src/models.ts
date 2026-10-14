/**
 * The models a bot may run on, as `claude --model` takes them: aliases for the latest of a family, and
 * full ids to pin a version. Add new models here and drop deprecated ones.
 */
export const BOT_MODELS = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
] as const;

/** The harnesses a bot may run on (the CLI's bots/harnesses). */
export const BOT_HARNESSES = ["claude", "cursor"] as const;
export type BotHarness = (typeof BOT_HARNESSES)[number];

/**
 * Whether `model` is one the harness takes. Claude's are a fixed list; Cursor's change often and depend on the
 * account, so any name goes through and `cursor-agent` has the last word.
 */
export function modelFits(harness: BotHarness, model: string): boolean {
  return harness === "claude" ? (BOT_MODELS as readonly string[]).includes(model) : model.trim().length > 0;
}
