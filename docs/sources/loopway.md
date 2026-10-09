# Loopway

An inbox with `source_type: "loopway"` receives messages posted straight to it. Bots and backends use these inboxes to send each other messages.

## Config

`{ "secret"?: string (≥16 chars, generated if omitted), "events"?: ["build.finished", ...] (default ["*"]), "schema"?: JSON Schema }`

loopway makes the secret; it is the inbox token senders use as a bearer token.

`schema` is a JSON Schema (2020-12) every message must match. Its `required` must include `type`, `id` and `data`; the default, `{"type": "object", "required": ["type", "id", "data"]}`, accepts any values for them. Set it with `loopway inbox create --schema schema.json` or `loopway inbox update <inbox> --schema schema.json`.

## Sending a message

```sh
curl -X POST <webhook_url> \
  -H "Authorization: Bearer <inbox token>" \
  -H "Content-Type: application/json" \
  -d '{"type": "build.finished", "id": "build-42", "data": {"ok": true}}'
```

`type` is a non-empty string, `id` is a string or number naming what the message is about, and `data` is the message.

## Delivery

Messages are authenticated by `Authorization: Bearer <inbox token>`. A body that doesn't match the inbox schema answers `400`; a `type` not in `config.events` answers `422`. Every message is stored as a new event, so nothing is deduped.

## CloudEvent mapping

`id` = a new UUID per message, `type` = body `type`, `source` = the inbox's webhook URL, `subject` = `<type>/<id>` with body `id` (so every message about the same thing shares a subject), `time` = receive time, `data` = body `data`.
