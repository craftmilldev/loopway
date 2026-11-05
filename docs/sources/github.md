# GitHub

A source of type `github` lets your inbox receive a repository's or organization's webhooks.

## Setup

`loopway source register github` prints your inbox URL and a secret. loopway makes the secret and shows it once; it is stored encrypted and never returned again. To use your own, pass `--secret` (at least 16 characters). Give each source a `--name` if you register several, such as one per organization.

In GitHub → Settings → Webhooks: Payload URL = your inbox URL, Content type = `application/json`, Secret = the secret from `register`. GitHub sends nothing until the webhook is added. The command also prints a `gh api` line that adds it. GitHub's event picker decides what is sent; loopway stores every event that verifies.

## Delivery

loopway recognizes a GitHub delivery by its `X-GitHub-Event` or `X-Hub-Signature-256` header, and authenticates it by `X-Hub-Signature-256` (HMAC-SHA256 over the raw body with the secret), trying each of your `github` sources. A delivery none of them verifies answers `401` with code `unverified` and is not stored. `ping` answers `200 {ignored: true}`. A redelivery of a stored event answers `200 {duplicate: true}`.

## CloudEvent mapping

Follows the [CloudEvents GitHub adapter spec](https://github.com/cloudevents/spec/blob/main/cloudevents/adapters/github.md): `id` = `X-GitHub-Delivery`, `type` = `com.github.<event>.<action>` (e.g. `com.github.pull_request.opened`; events with no action, like `push`, are `com.github.<event>`), `source`/`subject`/`time` per event, `data` = payload.
