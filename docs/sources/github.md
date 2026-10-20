# GitHub

An inbox with `source_type: "github"` receives a repository's or organization's webhooks.

## Config

`{ "secret"?: string (≥16 chars, generated if omitted), "events"?: ["push", "pull_request", ...] (default ["*"]) }`

loopway makes the secret and shows it once, in the response that creates the inbox (`inbox create` prints it). It is stored encrypted and never returned again.

## Setup

In GitHub → Settings → Webhooks: Payload URL = `webhook_url`, Content type = `application/json`, Secret = the `config.secret` from the create response.

For `loopway bots run`, the webhook needs `issues`, `issue_comment`, `pull_request`, `pull_request_review` and `pull_request_review_comment`.

## Delivery

Deliveries are authenticated by `X-Hub-Signature-256` (HMAC-SHA256 over the raw body with the secret). `ping` answers `200 {ignored: true}`. An event type not in `config.events` answers `422`; GitHub shows it as a failed delivery and doesn't retry it. A redelivery of a stored event answers `200 {duplicate: true}`.

## CloudEvent mapping

Follows the [CloudEvents GitHub adapter spec](https://github.com/cloudevents/spec/blob/main/cloudevents/adapters/github.md): `id` = `X-GitHub-Delivery`, `type` = `com.github.<event>.<action>` (e.g. `com.github.pull_request.opened`), `source`/`subject`/`time` per event, `data` = payload.
