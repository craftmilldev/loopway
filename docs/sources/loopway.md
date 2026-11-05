# Loopway

A source of type `loopway` lets scripts, CI jobs and services with no signed webhooks of their own post messages straight to your inbox.

## Setup

`loopway source register loopway --name builds` prints your inbox URL and a secret. The secret is the bearer token senders use. loopway makes it and shows it once; it is stored encrypted and never returned again. To use your own, pass `--secret` (at least 16 characters). Register one source per sender if you want to revoke them apart.

## Sending a message

```sh
curl -X POST <inbox URL> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"type": "build.finished", "id": "build-42", "data": {"ok": true}}'
```

`type` is a non-empty string, `id` is a string or number naming what the message is about, and `data`, which is optional, is the message.

## Delivery

Messages are authenticated by `Authorization: Bearer <token>`, trying each of your `loopway` sources. A message none of them verifies answers `401` with code `unverified` and is not stored. Your login session or API token is not a source's token, and answers the same. A content type other than `application/json` answers `415`; a body that isn't a JSON object, or has a bad `type` or `id`, answers `400`. Every message is stored as a new event, so nothing is deduped.

## CloudEvent mapping

`id` = a new UUID per message, `type` = body `type`, `source` = your inbox URL, `subject` = `<type>/<id>` with body `id` (so every message about the same thing shares a subject), `time` = receive time, `data` = body `data`.
