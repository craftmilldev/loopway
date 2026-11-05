# Schedule and purge

A schedule source fills the inbox on a clock, and messages drop out after 14 days. Vercel Cron calls one route for both. Runs within a window repeat the same CloudEvent ids, so a message is stored once.

## Sub-features

- `register` makes a schedule source.
- `tick` fills the inbox, and needs the cron secret.
- `repeat` is a second tick in the window, which stores nothing new.
- `refuse` is a tick without the secret.
- `purge` deletes expired messages on each tick.

## How to get to it (user POV)

Run `loopway source register schedule`. Nothing else: the cron does the rest.

## Driving it with curl and lw.sh

`up.sh` turns on `hour`, `day` and `week`, so an hourly source is due whenever you run this. The baseline gives you `URL`, `CRON_SECRET` and `DB`.

- **Register.** Run `"$V/lw.sh" "$RUN" source register schedule --name tick --every hour --message 'daily.report=write the report' --json`.
- **Refuse.** Run `curl -s -o /dev/null -w '%{http_code}\n' "$URL/api/cron/tick"`. `401`.
- **Tick.** Run `curl -s -H "authorization: Bearer $CRON_SECRET" "$URL/api/cron/tick"`. `"accepted":1`.
- **Repeat.** Run it again. `"accepted":0,"duplicate":1`.
- **Stored once.** Run `"$V/lw.sh" "$RUN" messages list --type 'dev.craftmill.*'`. One row, of type `dev.craftmill.loopway.schedule.daily.report`.
- **Purge.** Run `"$V/lw.sh" "$RUN" push old.message --id x-1`, age it with `docker exec loopway-postgres-1 psql -q -U postgres -d "$DB" -c "UPDATE loopway.messages SET received_at = now() - interval '15 days' WHERE ce_id = 'x-1'"`, then tick. `"purged":1`, and `messages list` doesn't show it.

## Gotchas

- A tick across an hour boundary is a new window, so **Repeat** can say `accepted`. Run it again.
- **Purge** writes to the database directly, because nobody can wait 14 days. That one step is setup, not the user path, and it only touches this run's database.
