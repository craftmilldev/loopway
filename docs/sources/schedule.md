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

The config is required, and an update replaces it whole. The inbox has no secret and no events list, and `POST /api/webhooks/<inbox>` answers `404`. Create it through the API (`POST /api/inboxes`); the dashboard and `loopway inbox create` don't offer it yet.

## Delivery

`GET /api/cron/schedules` is called by Vercel Cron every hour (`packages/web/vercel.json`) with `Authorization: Bearer $CRON_SECRET`. It stores the messages due in the current window for every schedule inbox. A run at 11:15 of an hourly inbox belongs to the 11:00 window; a daily inbox at hour 9 has windows from 09:00 to 09:00. Windows missed while the server or cron was down are not backfilled.

Every message of a type in a window has the same id, so a repeated run is a duplicate that is stored once, like a webhook redelivery.

Deploy: set `CRON_SECRET` (any random string; Vercel sends it as the bearer token). Without it the route answers `401`. Vercel's Hobby plan only runs crons once a day; hourly needs Pro.

## CloudEvent mapping

`id` = `subject` = sha256 of `<type>/<window start ISO>`, `type` = `dev.craftmill.loopway.schedule.<type>`, `source` = `urn:loopway:inbox:<inbox id>`, `time` = window start, `data` = `{ message, created_at }` (`created_at` is the window start).
