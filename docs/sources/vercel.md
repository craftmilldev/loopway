# Vercel

An inbox with `source_type: "vercel"` receives a team's webhooks.

## Config

`{ "secret"?: string, "events"?: ["deployment.error", ...] (default ["*"]) }`

Vercel makes the secret, so `config.secret` is `null` until you paste it in.

## Setup

In Vercel → Team Settings → Webhooks: Endpoint URL = `webhook_url`. Vercel shows a secret once the webhook is created; set it with `loopway inbox update <inbox> --secret <secret>` (or paste it on the inbox's dashboard page, or `PATCH` it into `config.secret`). Until then deliveries get `401`.

## Delivery

Deliveries are authenticated by `X-Vercel-Signature` (HMAC-SHA1 over the raw body with the secret). An event type not in `config.events` answers `422`. Vercel retries any non-2xx for up to 24 hours, so a delivery that arrives before the secret is set is retried once it is. A redelivery of a stored event answers `200 {duplicate: true}`.

## CloudEvent mapping

`id` = body `id`, `type` = `com.vercel.<type>` (e.g. `com.vercel.deployment.error`), `source` = the project's API URL (`https://api.vercel.com/v9/projects/<id>`, else the team's), `subject` = what the event is about (the deployment id for `deployment.*`, the project id for `project.*`, the domain name for `domain.*`, …, else the event id, so every event has one), `time` = `createdAt`, `data` = the whole body.
