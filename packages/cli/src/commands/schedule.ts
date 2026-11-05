import { readFileSync } from "node:fs";
import { UsageError } from "../context.js";
import { bold, fields } from "../format.js";

/** The flags that set a schedule, on `source register` and `source update`. */
export interface ScheduleFlags {
  every?: string;
  hour?: number;
  day?: number;
  message?: string[];
  messageFile?: string[];
  removeMessage?: string[];
  config?: ScheduleConfig;
}

export interface ScheduleConfig {
  schedule: { every: "hour" } | { every: "day"; hour: number } | { every: "week"; day: number; hour: number };
  messages: { type: string; message: string }[];
}

const TYPE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_MESSAGES = 20;
const MAX_TEXT = 10_000;

/** A bad schedule flag; `reason` is a low-cardinality label for metrics. */
class ScheduleFlagError extends UsageError {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** Collects a repeatable option into an array. */
export const collect = (value: string, previous: string[] = []) => [...previous, value];

export function parseHour(value: string): number {
  const hour = Number(value);
  if (!/^\d+$/.test(value) || hour > 23)
    throw new UsageError(`--hour must be a whole number from 0 to 23, got "${value}"`);
  return hour;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A UTC weekday as 0-6 (0 = Sunday) or its name or three-letter short form. */
export function parseDay(value: string): number {
  const named = WEEKDAYS.findIndex(
    (d) => d.toLowerCase() === value.toLowerCase() || d.slice(0, 3).toLowerCase() === value.toLowerCase(),
  );
  if (named >= 0) return named;
  if (/^[0-6]$/.test(value)) return Number(value);
  throw new UsageError(`--day must be 0-6 (0 is Sunday) or mon..sun, got "${value}"`);
}

export function readScheduleConfig(path: string): ScheduleConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UsageError(
      `Could not read a schedule config from ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`${path} must hold a JSON object like {"schedule": …, "messages": […]}`);
  }
  return value as ScheduleConfig;
}

/** Splits `<type>=<text>` at the first `=`. */
function splitMessage(flag: string, arg: string): [string, string] {
  const at = arg.indexOf("=");
  if (at < 1) throw new ScheduleFlagError("bad_message_flag", `${flag} takes <type>=<value>, got "${arg}"`);
  return [arg.slice(0, at), arg.slice(at + 1)];
}

/** The schedule's current config (or `--config`'s) with the flags applied; checks what the server checks. */
export function applyScheduleFlags(current: ScheduleConfig, opts: ScheduleFlags): ScheduleConfig {
  const base = opts.config ?? current;
  let schedule = base.schedule;
  const messages = new Map((base.messages ?? []).map((m) => [m.type, m.message]));

  if (opts.every !== undefined || opts.hour !== undefined || opts.day !== undefined) {
    const every = opts.every ?? schedule?.every;
    // Switching between daily and weekly keeps the hour.
    const hourOf = () => opts.hour ?? (schedule && schedule.every !== "hour" ? schedule.hour : undefined);
    if (every === "hour") {
      if (opts.hour !== undefined) {
        throw new ScheduleFlagError("bad_schedule", "--hour only applies with --every day or week");
      }
      if (opts.day !== undefined) throw new ScheduleFlagError("bad_schedule", "--day only applies with --every week");
      schedule = { every: "hour" };
    } else if (every === "day") {
      const hour = hourOf();
      if (opts.day !== undefined) throw new ScheduleFlagError("bad_schedule", "--day only applies with --every week");
      if (hour === undefined) throw new ScheduleFlagError("bad_schedule", "--every day needs --hour <0-23> (UTC)");
      schedule = { every: "day", hour };
    } else if (every === "week") {
      const hour = hourOf();
      const day = opts.day ?? (schedule?.every === "week" ? schedule.day : undefined);
      if (day === undefined || hour === undefined) {
        throw new ScheduleFlagError("bad_schedule", "--every week needs --day <0-6|mon..sun> and --hour <0-23> (UTC)");
      }
      schedule = { every: "week", day, hour };
    } else {
      throw new ScheduleFlagError("bad_schedule", `--every must be "hour", "day" or "week", got "${every}"`);
    }
  }

  for (const type of opts.removeMessage ?? []) {
    if (!messages.delete(type)) {
      throw new ScheduleFlagError("unknown_type", `--remove-message: no message type "${type}" to remove`);
    }
  }
  for (const arg of opts.message ?? []) {
    const [type, text] = splitMessage("--message", arg);
    messages.set(type, text);
  }
  for (const arg of opts.messageFile ?? []) {
    const [type, path] = splitMessage("--message-file", arg);
    try {
      messages.set(type, readFileSync(path, "utf8").replace(/\n$/, ""));
    } catch (err) {
      throw new ScheduleFlagError(
        "unreadable_file",
        `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const [type, text] of messages) {
    if (!TYPE_RE.test(type)) {
      throw new ScheduleFlagError(
        "bad_type",
        `Message type "${type}" must be lowercase letters, digits, '.', '_' or '-' (up to 64 characters)`,
      );
    }
    if (!text) throw new ScheduleFlagError("empty_text", `Message "${type}" needs some text`);
    if (text.length > MAX_TEXT) {
      throw new ScheduleFlagError(
        "text_too_long",
        `Message "${type}" is ${text.length} characters; the limit is ${MAX_TEXT}`,
      );
    }
  }
  if (!messages.size) throw new ScheduleFlagError("no_messages", "A schedule needs at least one message");
  if (messages.size > MAX_MESSAGES) {
    throw new ScheduleFlagError(
      "too_many_messages",
      `A schedule takes up to ${MAX_MESSAGES} messages, this has ${messages.size}`,
    );
  }
  return { schedule, messages: [...messages].map(([type, message]) => ({ type, message })) };
}

const everyText = (s: ScheduleConfig["schedule"] | undefined) =>
  s?.every === "week"
    ? `weekly on ${WEEKDAYS[s.day]} at ${String(s.hour).padStart(2, "0")}:00 UTC`
    : s?.every === "day"
      ? `daily at ${s.hour}:00 UTC`
      : "every hour";

/** What `source show` prints for a schedule: the schedule, then each message type with its text. */
export function scheduleText(config: Partial<ScheduleConfig>): string {
  const lines = [fields([["schedule", everyText(config.schedule)]])];
  for (const m of config.messages ?? []) lines.push("", bold(m.type), m.message);
  return lines.join("\n");
}
