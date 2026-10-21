# Schedule

An inbox with `source_type: "schedule"` fills itself on a clock: each hour, or each day at an hour you pick (UTC), it gets one message per message type you configured, carrying that type's text. Nothing is fetched or polled; use it to wake a bot up on a rhythm.

## Config

```json
{
  "schedule": { "every": "hour" },
  "messages": [{ "type": "standup", "message": "Write the standup" }]
}
```

- `schedule`: `{ "every": "hour" }` or `{ "every": "day", "hour": 0-23 }` (UTC).
- `messages`: 1–20 of `{ type, message }`. `type` is lowercase letters, digits, `.`, `_` or `-` and unique within the inbox; `message` is the text (up to 10,000 characters).

The config is required, and an update replaces it whole. The inbox has no secret and no events list, and `POST /api/webhooks/<inbox>` answers `404`. Create it in the dashboard (New inbox → Schedule), with `loopway inbox create --source schedule` (below), or with `POST /api/inboxes`.

## Creating it from the CLI

`loopway inbox create --source schedule` takes the same schedule flags as `update`, and checks the same limits. With no terminal it needs a schedule and at least one message, and refuses `--events`, `--secret` and `--schema`:

```sh
loopway inbox create --name clock --source schedule --every day --hour 9 --message standup="Write the standup"
loopway inbox create --name clock --source schedule --config schedule.json
```

In a terminal, pick Schedule as the source and it asks for the schedule, then the messages.

## Changing it from the CLI

`loopway inbox update <inbox>` reads the inbox's current config, applies your flags and sends the whole config, so adding one type keeps the others:

```sh
loopway inbox update clock --every hour
loopway inbox update clock --every day --hour 9          # UTC; --hour alone changes a daily inbox's hour
loopway inbox update clock --message standup="Write the standup"      # add or replace a type (repeatable)
loopway inbox update clock --message-file report=report.md            # long text from a file (repeatable)
loopway inbox update clock --remove-message standup                   # (repeatable)
loopway inbox update clock --config schedule.json        # replace the whole {schedule, messages}; other flags then apply on top
```

With no flags in a terminal it asks for the schedule, then lets you add, edit and remove messages. The schedule flags are refused on any other source. The CLI checks the same limits as the server (1–20 messages, type characters, unique types, text up to 10,000 characters, hour 0–23) and passes the server's own errors through. `loopway inbox show <inbox>` prints the schedule and each message type with its text.

## Delivery

`GET /api/cron/schedules` is called by Vercel Cron (`packages/web/vercel.json`, daily at 00:00 UTC by default; an hourly cron is `0 * * * *`) with `Authorization: Bearer $CRON_SECRET`. It stores the messages due in the current window for every schedule inbox. A run at 11:15 of an hourly inbox belongs to the 11:00 window; a daily inbox at hour 9 has windows from 09:00 to 09:00. Windows missed while the server or cron was down are not backfilled.

Every message of a type in a window has the same id, so a repeated run is a duplicate that is stored once, like a webhook redelivery.

Deploy: set `CRON_SECRET` (any random string; Vercel sends it as the bearer token). Without it the route answers `401`. 
Which options a deploy offers is set by `SCHEDULE_OPTIONS` (`hour`, `day` or `hour,day`; default `day`). Vercel's Hobby plan only runs crons once a day, so hourly needs Pro, an hourly cron in `vercel.json`, and `SCHEDULE_OPTIONS=hour,day`. A disabled option is not offered in the dashboard (`GET /api/sources` lists `schedule_options`), creating or updating a schedule with it answers `400 schedule_option_disabled`, and the cron skips inboxes already set to it (the response counts them as `disabled`). With only `day` on and a daily cron, a daily inbox gets its window's messages at the next tick, so up to a day after its hour.

## CloudEvent mapping

`id` = `subject` = sha256 of `<type>/<window start ISO>`, `type` = `dev.craftmill.loopway.schedule.<type>`, `source` = `urn:loopway:inbox:<inbox id>`, `time` = window start, `data` = `{ message, created_at }` (`created_at` is the window start).
