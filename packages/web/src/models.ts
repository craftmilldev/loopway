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
