# Schedule

A source of type `schedule` fills your inbox on a clock: each hour, each day at an hour you pick, or each week on a weekday and hour you pick (UTC), it adds one message per message type you configured, carrying that type's text. Nothing is fetched or polled.

## Config

```json
{
  "schedule": { "every": "hour" },
  "messages": [{ "type": "standup", "message": "Write the standup" }]
}
```

- `schedule`: `{ "every": "hour" }`, `{ "every": "day", "hour": 0-23 }` or `{ "every": "week", "day": 0-6, "hour": 0-23 }` (UTC; `day` is the weekday, 0 = Sunday).
- `messages`: 1–20 of `{ type, message }`. `type` is lowercase letters, digits, `.`, `_` or `-` (up to 64 characters) and unique within the source; `message` is the text (up to 10,000 characters).

The config is required, and an update replaces it whole. The source has no secret and no webhook URL, and no delivery to your inbox reaches it. Register it with `loopway source register schedule` (below), or with `POST /api/sources {type: "schedule", name, config}`.

## Registering it from the CLI

`loopway source register schedule` needs a schedule and at least one message, and checks the same limits as the server:

```sh
loopway source register schedule --name clock --every day --hour 9 --message standup="Write the standup"
loopway source register schedule --name review --every week --day mon --hour 13 --message review="Review the week's costs"
loopway source register schedule --name clock --config schedule.json
```

## Changing it from the CLI

`loopway source update <source>` reads the source's current config, applies your flags and sends the whole config, so adding one type keeps the others:

```sh
loopway source update clock --every hour
loopway source update clock --every day --hour 9          # UTC; --hour alone changes a daily schedule's hour
loopway source update clock --every week --day mon --hour 13   # --day takes 0-6 (0 = Sunday) or sun..sat; --day or --hour alone changes a weekly schedule
loopway source update clock --message standup="Write the standup"      # add or replace a type (repeatable)
loopway source update clock --message-file report=report.md            # long text from a file (repeatable)
loopway source update clock --remove-message standup                   # (repeatable)
loopway source update clock --config schedule.json        # replace the whole {schedule, messages}; other flags then apply on top
```

The schedule flags are refused on any other source. The CLI checks the same limits as the server (1–20 messages, type characters, unique types, text up to 10,000 characters, hour 0–23) and passes the server's own errors through. `loopway source show <source>` prints the schedule and each message type with its text.

## Delivery

`GET /api/cron/tick` is called by Vercel Cron (`packages/web/vercel.json`, daily at 00:00 UTC by default; an hourly cron is `0 * * * *`) with `Authorization: Bearer $CRON_SECRET`. It stores the messages due in the current window for every schedule source, then deletes messages past retention, and answers with the counts `{sources, accepted, duplicate, failed, disabled, purged}`. A run at 11:15 of an hourly source belongs to the 11:00 window; a daily source at hour 9 has windows from 09:00 to 09:00; a weekly source on Monday at 13:00 has windows from one Monday 13:00 to the next, so it stores one message a week. Windows missed while the server or cron was down are not backfilled.

Every message of a type in a window has the same id, so a repeated run is a duplicate that is stored once, like a webhook redelivery.

Deploy: set `CRON_SECRET` (any random string; Vercel sends it as the bearer token). Without it the route answers `401`.
Which options a deploy offers is set by `SCHEDULE_OPTIONS` (any of `hour`, `day`, `week`, comma-separated; default `day,week`). Vercel's Hobby plan only runs crons once a day, so hourly needs Pro, an hourly cron in `vercel.json`, and `SCHEDULE_OPTIONS=hour,day,week`. `GET /api/source-types` lists the options on offer as `schedule_options`. Registering a schedule with a disabled option, or updating one to it, answers `400 schedule_option_disabled`, and the cron skips sources already set to it (the response counts them as `disabled`). With only `day` on and a daily cron, a daily or weekly source gets its window's messages at the next tick, so up to a day after its hour.

## CloudEvent mapping

`id` = `subject` = sha256 of `<type>/<window start ISO>`, `type` = `dev.craftmill.loopway.schedule.<type>`, `source` = `urn:loopway:source:<source id>`, `time` = window start, `data` = `{ message, created_at }` (`created_at` is the window start).
