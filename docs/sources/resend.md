# Resend

A source of type `resend` lets your inbox receive what happens to the emails you send and receive through [Resend](https://resend.com): sent, delivered, bounced, complained, opened, clicked and more, plus contact and domain changes.

## Setup

Resend generates the signing secret after it has the URL, so:

1. `loopway source register resend` and copy the webhook URL it prints (`loopway inbox` shows the same URL).
2. In Resend: Webhooks → Add Webhook. Paste the URL and pick the events you want. loopway stores every event that verifies.
3. Copy the `whsec_…` signing secret from the webhook's page and run `loopway source update resend --secret whsec_…`. A secret that doesn't look like `whsec_<base64>` answers `400`. Until it is set, deliveries get `401`.
4. Send an email, and check `loopway messages list`.

## Delivery

loopway recognizes a Resend delivery by its `svix-signature` header, and authenticates it by that [Svix](https://docs.svix.com/receiving/verifying-payloads/how-manual) signature (Resend's webhooks are sent through Svix), with the `svix-timestamp` within 5 minutes, trying each of your `resend` sources. A delivery none of them verifies answers `401` with code `unverified` and is not stored. A redelivery of a stored event answers `200 {duplicate: true}`.

## CloudEvent mapping

`id` = `svix-id`, `type` = `com.resend.<type>` (e.g. `com.resend.email.bounced`), `source` = `https://api.resend.com/emails/<email_id>` (`https://api.resend.com` for contact and domain events), `subject` = the email id (or the domain or contact id), `time` = `created_at`, falling back to receive time, `data` = payload.
