# Linear

An inbox with `source_type: "linear"` receives a workspace's webhooks.

## Config

`{ "secret"?: string, "events"?: ["issue.create", ...] (default ["*"]) }`

Event names are `<type>.<action>`, lowercased. Linear makes the secret, so `config.secret_set` is `false` until you paste it in.

## Setup

In Linear → Settings → API → Webhooks: URL = `webhook_url`, and pick the resource types to send (Issues, Comments, …). Linear shows a signing secret once the webhook is created; set it with `loopway inbox update <inbox> --secret <secret>` (or paste it on the inbox's dashboard page, or `PATCH` it into `config.secret`). Until then deliveries get `401`.

## Delivery

Deliveries are authenticated by `Linear-Signature` (HMAC-SHA256 over the raw body with the secret). An event not in `config.events` answers `422`. A redelivery of a stored event (same `Linear-Delivery`) answers `200 {duplicate: true}`.

## CloudEvent mapping

`id` = the `Linear-Delivery` header, `type` = `com.linear.<type>.<action>` lowercased (e.g. `com.linear.issue.create`), `source` = `https://linear.app/<organizationId>`, `subject` = the issue the event is about (`data.issueId` for comments, else `data.id`), `time` = `createdAt`, `data` = the whole body.

This source only stores messages. It isn't tied into thread assignment yet.

## Test message

The test message is an `issue.create` event for a made-up issue, `TEST-1`. If `config.events` leaves out `issue.create`, it is `issue.update` or `issue.remove`. It needs the signing secret to be set first (`409 secret_not_set` otherwise).
