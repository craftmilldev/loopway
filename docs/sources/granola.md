# Granola

An inbox with `source_type: "granola"` receives note events from a Granola workspace or folder.

## Config

`{ "secret"?: "whsec_…", "events"?: ["note.generated", "note.edited", "note.access_granted"] (default ["*"]) }`

Granola makes the secret, so `config.secret` is `null` until you paste it in.

## Setup

Granola webhooks need a Business or Enterprise plan. Granola generates the signing secret after it has the URL, so:

1. `loopway inbox create --name notes --source granola` and copy its `webhook_url`.
2. In the Granola desktop app: Settings → Connectors → Webhooks → Set up a webhook (or a folder → Integrations → Webhooks for one folder). Paste the URL.
3. Copy the `whsec_…` secret Granola shows (only once) and run `loopway inbox update notes --secret whsec_…`, or paste it on the inbox's dashboard page. Until then the inbox answers `401`, and Granola drops those deliveries without retrying.
4. Record a meeting, or edit a note's summary, and check `loopway events list notes`.

Each event only carries `note_id`; fetch the note itself with a Granola API key (Settings → Connectors → API keys): `curl -H "Authorization: Bearer grn_…" <event source>`.

## Delivery

Deliveries are authenticated by the [Standard Webhooks](https://www.standardwebhooks.com) `webhook-signature` header, with the `webhook-timestamp` within 5 minutes. An event type not in `config.events` answers `422`. Granola retries only `408`, `429` and `5xx`, so a `401` or `422` is dropped. A redelivery of a stored event answers `200 {duplicate: true}`.

## CloudEvent mapping

`id` = `webhook-id`, `type` = `ai.granola.<event_type>` (e.g. `ai.granola.note.generated`), `source` = `https://public-api.granola.ai/v1/notes/<note_id>`, `subject` = `note_id`, `time` = `occurred_at`, `data` = payload.
