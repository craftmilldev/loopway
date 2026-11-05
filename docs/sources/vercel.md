# Vercel

A source of type `vercel` lets your inbox receive a team's webhooks.

## Setup

Vercel makes the secret once the webhook exists, so:

1. `loopway source register vercel` and copy the webhook URL it prints (`loopway inbox` shows the same URL).
2. In Vercel → Team Settings → Webhooks: Endpoint URL = your inbox URL.
3. Copy the secret Vercel shows and run `loopway source update vercel --secret <secret>`. Until it is set, deliveries get `401`.

## Delivery

loopway recognizes a Vercel delivery by its `X-Vercel-Signature` header, and authenticates it by that header (HMAC-SHA1 over the raw body with the secret), trying each of your `vercel` sources. A delivery none of them verifies answers `401` with code `unverified` and is not stored. Vercel retries any non-2xx for up to 24 hours, so a delivery that arrives before the secret is set is retried once it is. A redelivery of a stored event answers `200 {duplicate: true}`.

## CloudEvent mapping

`id` = body `id`, `type` = `com.vercel.<type>` (e.g. `com.vercel.deployment.error`), `source` = the project's API URL (`https://api.vercel.com/v9/projects/<id>`, else the team's, else `https://vercel.com`), `subject` = what the event is about (the deployment id for `deployment.*`, the project id for `project.*`, the domain name for `domain.*`, …, else the event id, so every event has one), `time` = `createdAt`, falling back to receive time, `data` = the whole body.
