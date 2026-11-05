# The inbox and its sources

A user has one inbox at one URL. A source is a sender registered with its signing secret, and a delivery is matched to a source by how it signs.

## Sub-features

- `inbox` shows the URL and counts.
- `types` lists what can be registered.
- `register` stores a source.
- `list` and `show` read it back, without the secret.
- `remove` refuses that source's deliveries from then on.

## How to get to it (user POV)

Run `loopway inbox` for the URL, then `loopway source register github` for the secret, and put both in the sender's settings.

## Driving it with lw.sh

- **Inbox.** Run `"$V/lw.sh" "$RUN" inbox --json`. `url` ends in `/api/webhooks/<user id>`, with `sources`, `messages` and `retention_days` of `14`.
- **Types.** Run `"$V/lw.sh" "$RUN" source types`. It lists `github`, `granola`, `linear`, `loopway`, `resend`, `schedule` and `vercel`.
- **Register.** Run `"$V/lw.sh" "$RUN" source register github --name gh --secret verify-secret-0123456789 --json`. `secret_set` is `true`, and `webhook_url` is the inbox URL.
- **List.** Run `"$V/lw.sh" "$RUN" source list`. `gh`, secret `set`, last delivery `never`.
- **Show.** Run `"$V/lw.sh" "$RUN" source show gh`. It prints `secret set`, never the value.
- **Remove.** Run `"$V/lw.sh" "$RUN" source register schedule --name tick --every hour --message 'daily.report=hi'`, then `"$V/lw.sh" "$RUN" source remove tick`, then `source list`. `tick` is gone, and the command prints `Removed tick. Its messages stay until they expire.`

## Gotchas

- `--secret` must be at least 16 characters.
- Without `--secret`, a `loopway`-secret type generates one and shows it once. `sender`-secret types need the one the sender shows.
