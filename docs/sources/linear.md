# Linear

A source of type `linear` lets your inbox receive a workspace's webhooks.

## Setup

Linear makes the secret once the webhook exists, so:

1. `loopway source register linear` and copy the webhook URL it prints (`loopway inbox` shows the same URL).
2. In Linear → Settings → API → Webhooks: URL = your inbox URL, and pick the resource types to send (Issues, Comments, …).
3. Copy the signing secret Linear shows and run `loopway source update linear --secret <secret>`. Until it is set, deliveries get `401`.

## Delivery

loopway recognizes a Linear delivery by its `Linear-Signature` header, and authenticates it by that header (HMAC-SHA256 over the raw body with the secret), trying each of your `linear` sources. A delivery none of them verifies answers `401` with code `unverified` and is not stored. A redelivery of a stored event (same `Linear-Delivery`) answers `200 {duplicate: true}`.

## CloudEvent mapping

`id` = the `Linear-Delivery` header (without one, `webhookTimestamp` + `data.id`), `type` = `com.linear.<type>.<action>` lowercased (e.g. `com.linear.issue.create`), `source` = `https://linear.app/<organizationId>` (`https://linear.app` without one), `subject` = the issue the event is about (`data.issueId` for comments, else `data.id`), `time` = `createdAt`, falling back to receive time, `data` = the whole body.
