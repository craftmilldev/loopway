# Granola

A source of type `granola` lets your inbox receive note events from a Granola workspace or folder: `note.generated`, `note.edited` and `note.access_granted`.

## Setup

Granola webhooks need a Business or Enterprise plan. Granola generates the signing secret after it has the URL, so:

1. `loopway source register granola` and copy the webhook URL it prints (`loopway inbox` shows the same URL).
2. In the Granola desktop app: Settings → Connectors → Webhooks → Set up a webhook (or a folder → Integrations → Webhooks for one folder). Paste the URL.
3. Copy the `whsec_…` secret Granola shows (only once) and run `loopway source update granola --secret whsec_…`. A secret that doesn't look like `whsec_<base64>` answers `400`. Until it is set, deliveries get `401`, and Granola drops them without retrying.
4. Record a meeting, or edit a note's summary, and check `loopway messages list`.

Each event only carries `note_id`; fetch the note itself with a Granola API key (Settings → Connectors → API keys): `curl -H "Authorization: Bearer grn_…" <event source>`.

## Delivery

loopway recognizes a Granola delivery by its `webhook-signature` header, and authenticates it by that [Standard Webhooks](https://www.standardwebhooks.com) signature, with the `webhook-timestamp` within 5 minutes, trying each of your `granola` sources. A delivery none of them verifies answers `401` with code `unverified` and is not stored. Granola retries only `408`, `429` and `5xx`, so a `401` is dropped. A redelivery of a stored event answers `200 {duplicate: true}`. A signed delivery with no `note_id`, such as the test event the webhook dialog sends, answers `200 {ignored: true}` and stores nothing; `loopway source show granola` shows `ignored:no_note:<event_type>` as the last delivery.

## CloudEvent mapping

`id` = `webhook-id`, `type` = `ai.granola.<event_type>` (e.g. `ai.granola.note.generated`), `source` = `https://public-api.granola.ai/v1/notes/<note_id>`, `subject` = `note_id`, `time` = `occurred_at`, falling back to receive time, `data` = payload.
