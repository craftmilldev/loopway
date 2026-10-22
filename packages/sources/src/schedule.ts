import { createHash } from "node:crypto";
import { z } from "zod";
import type { SourceAdapter, SourceDeps } from "./types.js";

/**
 * A clock instead of a sender. On every window of its schedule (each hour, or each day at a set hour, UTC) the
 * inbox gets one message per configured message type, carrying that type's text. Nothing is polled or fetched.
 *
 *   id      = hash of <type>/<window start>, the same for every run in a window, so a repeat run is a duplicate
 *   type    = dev.craftmill.loopway.schedule.<type>
 *   source  = urn:loopway:inbox:<inbox id>
 *   subject = the same hash as the id
 *   time    = window start (the run time truncated down to the hour, or the day's hour)
 *   data    = { message, created_at } (created_at is the window start)
 *
 * The server's cron route calls `tick` for every schedule inbox; `receive` refuses webhooks.
 */

export type Every = { every: "hour" } | { every: "day"; hour: number };

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

/** The start of the window `now` falls in: the hour, or the most recent `hour:00` UTC. */
export function windowStart(every: Every, now: Date): Date {
  const t = now.getTime();
  if (every.every === "hour") return new Date(t - (t % HOUR));
  const offset = every.hour * HOUR;
  return new Date(Math.floor((t - offset) / DAY) * DAY + offset);
}

export const schedule = ({ makeCloudEvent }: SourceDeps): SourceAdapter<ScheduleConfig> => ({
  type: "schedule",
  label: "Schedule",
  description: "Messages with text you set, sent every hour or once a day at an hour you pick (UTC).",
  events: [],
  secret: { from: "none" },
  webhookSettings: "nowhere: this inbox takes no webhooks",

  parseConfig(input, existing) {
    const parsed = configInput.safeParse(input ?? existing);
    if (!parsed.success) throw parsed.error;
    // Without strictNullChecks (Vercel's compile) zod infers every field as optional, hence the cast.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    return parsed.data as ScheduleConfig;
  },

  publicConfig(config) {
    return { schedule: config.schedule, messages: config.messages };
  },

  setup(config) {
    return {
      schedule: config.schedule.every === "hour" ? "every hour" : `daily at ${config.schedule.hour}:00 UTC`,
      types: config.messages.map((m) => m.type),
    };
  },

  receive() {
    return { kind: "rejected", status: 404, message: "This inbox is fed by a schedule, not webhooks" };
  },

  summarize(event) {
    const message = (event.data as { message?: unknown } | undefined)?.message;
    return typeof message === "string" ? message.split("\n")[0]!.slice(0, 200) : null;
  },

  title() {
    return null;
  },

  tick(config, inboxId, now) {
    const start = windowStart(config.schedule, now).toISOString();
    return config.messages.map((m) => {
      const hash = createHash("sha256").update(`${m.type}/${start}`).digest("hex");
      return makeCloudEvent({
        specversion: "1.0",
        id: hash,
        source: `urn:loopway:inbox:${inboxId}`,
        type: `dev.craftmill.loopway.schedule.${m.type}`,
        subject: hash,
        time: start,
        datacontenttype: "application/json",
        data: { message: m.message, created_at: start },
      });
    });
  },
});
