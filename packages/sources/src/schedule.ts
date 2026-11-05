import { createHash } from "node:crypto";
import { z } from "zod";
import type { SourceAdapter, SourceDeps } from "./types.js";

/**
 * A clock instead of a sender. On every window of its schedule (each hour, each day at a set hour, or each week on a set weekday and hour, UTC) the
 * inbox gets one message per configured message type, carrying that type's text. Nothing is polled or fetched.
 *
 *   id      = hash of <type>/<window start>, the same for every run in a window, so a repeat run is a duplicate
 *   type    = dev.craftmill.loopway.schedule.<type>
 *   source  = urn:loopway:source:<source id>
 *   subject = the same hash as the id
 *   time    = window start (the run time truncated down to the hour, or the day's or week's hour)
 *   data    = { message, created_at } (created_at is the window start)
 *
 * The server's cron route calls `tick` for every schedule source.
 */

/** `day` is the UTC weekday, 0 = Sunday. */
export type Every = { every: "hour" } | { every: "day"; hour: number } | { every: "week"; day: number; hour: number };

export interface ScheduleMessage {
  /** Message type, the last part of the CloudEvent type. */
  type: string;
  /** Text delivered with every message of this type. */
  message: string;
}

export interface ScheduleConfig {
  schedule: Every;
  messages: ScheduleMessage[];
}

const MAX_MESSAGES = 20;

const configInput = z
  .object({
    schedule: z.discriminatedUnion("every", [
      z.object({ every: z.literal("hour") }).strict(),
      z.object({ every: z.literal("day"), hour: z.number().int().min(0).max(23) }).strict(),
      z
        .object({
          every: z.literal("week"),
          day: z.number().int().min(0).max(6),
          hour: z.number().int().min(0).max(23),
        })
        .strict(),
    ]),
    messages: z
      .array(
        z
          .object({
            type: z
              .string()
              .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "type must be lowercase letters, digits, '.', '_' or '-'"),
            message: z.string().min(1).max(10_000),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_MESSAGES)
      .refine((m) => new Set(m.map((x) => x.type)).size === m.length, "message types must be unique"),
  })
  .strict();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** The start of the window `now` falls in: the hour, or the most recent `hour:00` UTC (on `day` for a week). */
export function windowStart(every: Every, now: Date): Date {
  const t = now.getTime();
  if (every.every === "hour") return new Date(t - (t % HOUR));
  const offset = every.hour * HOUR;
  if (every.every === "week") {
    // 1970-01-01 was a Thursday (weekday 4), so shifting by 4 days makes epoch weeks start on Sunday.
    const shift = (every.day - 4) * DAY + offset;
    return new Date(Math.floor((t - shift) / WEEK) * WEEK + shift);
  }
  return new Date(Math.floor((t - offset) / DAY) * DAY + offset);
}

export const schedule = ({ makeCloudEvent }: SourceDeps): SourceAdapter<ScheduleConfig> => ({
  type: "schedule",
  label: "Schedule",
  description:
    "Messages with text you set, sent every hour, once a day at an hour you pick, or once a week on a weekday and hour you pick (UTC).",
  secret: { from: "none" },
  webhookSettings: "nowhere: a schedule takes no webhooks",

  parseConfig(input, existing) {
    const parsed = configInput.safeParse(input ?? existing);
    if (!parsed.success) throw parsed.error;
    // Without strictNullChecks (Vercel's compile) zod infers every field as optional, hence the cast.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    return parsed.data as ScheduleConfig;
  },

  tick(config, sourceId, now) {
    const start = windowStart(config.schedule, now).toISOString();
    return config.messages.map((m) => {
      const hash = createHash("sha256").update(`${m.type}/${start}`).digest("hex");
      return makeCloudEvent({
        specversion: "1.0",
        id: hash,
        source: `urn:loopway:source:${sourceId}`,
        type: `dev.craftmill.loopway.schedule.${m.type}`,
        subject: hash,
        time: start,
        datacontenttype: "application/json",
        data: { message: m.message, created_at: start },
      });
    });
  },
});
