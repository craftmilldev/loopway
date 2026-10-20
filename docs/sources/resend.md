# Resend

An inbox with `source_type: "resend"` receives what happens to the emails you send and receive through [Resend](https://resend.com): sent, delivered, bounced, complained, opened, clicked and more, plus contact and domain changes.

## Config

`{ "secret"?: "whsec_…", "events"?: ["email.sent", "email.delivered", "email.delivery_delayed", "email.complained", "email.bounced", "email.opened", "email.clicked", "email.failed", "email.scheduled", "email.suppressed", "email.received", "contact.created", "contact.updated", "contact.deleted", "domain.created", "domain.updated", "domain.deleted"] (default ["*"]) }`

Resend makes the secret, so `config.secret_set` is `false` until you paste it in.

## Setup

Resend generates the signing secret after it has the URL, so:

1. `loopway inbox create --name mail --source resend` and copy its `webhook_url`.
2. In Resend: Webhooks → Add Webhook. Paste the URL and pick the events you want.
3. Copy the `whsec_…` signing secret from the webhook's page and run `loopway inbox update mail --secret whsec_…`, or paste it on the inbox's dashboard page. Until then the inbox answers `401`.
4. Send an email, and check `loopway messages list mail`.

## Delivery

Deliveries are authenticated by the [Svix](https://docs.svix.com/receiving/verifying-payloads/how-manual) `svix-signature` header (Resend's webhooks are sent through Svix), with the `svix-timestamp` within 5 minutes. An event type not in `config.events` answers `422`. A redelivery of a stored event answers `200 {duplicate: true}`.

## CloudEvent mapping

`id` = `svix-id`, `type` = `com.resend.<type>` (e.g. `com.resend.email.bounced`), `source` = `https://api.resend.com/emails/<email_id>` (`https://api.resend.com` for contact and domain events), `subject` = the email id (or the domain or contact id), `time` = `created_at`, `data` = payload.
