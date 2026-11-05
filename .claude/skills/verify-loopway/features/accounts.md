# Accounts

A person signs up or logs in with a code sent by email, and the CLI keeps a 30-day session token.

## Sub-features

- `signup` makes an account from a new email and a username.
- `login` logs an existing email in, with no username.
- `whoami` shows who the CLI is logged in as.
- `username` changes the username.

## How to get to it (user POV)

Run `loopway login`, type the emailed code, and pick a username if the email is new.

## Driving it with lw.sh

Start from the baseline without signing in.

- **Signup.** Run `"$V/sign-in.sh" "$RUN" ada@example.com ada-verify`. Exit `0` and stdout starts `Created your account and logged in`.
- **Token saved in the throwaway HOME.** `"$RUN/home/.loopway/config.json"` exists with mode `0600`.
- **Who am I.** Run `"$V/lw.sh" "$RUN" whoami --json`. It shows `"username": "ada-verify"` and `"email": "ada@example.com"`.
- **Rename.** Run `"$V/lw.sh" "$RUN" username ada-two`, then `"$V/lw.sh" "$RUN" whoami --json`. `username` is `ada-two`, and `name` stays `ada-verify`.
- **Login, not signup.** Run `"$V/sign-in.sh" "$RUN" ada@example.com ignored`. Stdout starts `Logged in to`, and the username you passed is ignored.

## Gotchas

- One unredeemed code per address per 10 minutes. Redeeming one deletes it, so logging in again straight away works. But asking for a code and not using it blocks the next one, and `sign-in.sh` would then fail with the spent code from the log.
- `sign-in.sh` reads the code from the server's console because `up.sh` blanks `RESEND_API_KEY`. Real email isn't covered.
- `loopway username` with no argument and no terminal fails with `A username is required`. That's expected.
