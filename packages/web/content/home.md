loopway catches webhooks and keeps them in an inbox as [CloudEvents](https://github.com/cloudevents/spec). A script, a cron job or an agent then claims events one at a time, works on them, and marks them done.

## Use it

1. [Log in](/login) with your email. New emails get an account.
2. Create an inbox from the [dashboard](/dashboard). It gives you a webhook URL.
3. Paste that URL and your secret into the webhook settings of the service that sends events (GitHub and Vercel so far; for Vercel you paste the secret it gives you back into loopway).
4. Pull work from the inbox with the CLI or the API.

## The CLI

```
loopway login
loopway inbox list
loopway events list <inbox> --status pending
loopway events next <inbox> --json
loopway events done <inbox> <event>
```

`next` locks the oldest pending event for you. If you stop, the lock expires and the event goes back in the queue.

## The API

```
curl -H "Authorization: Bearer $TOKEN" \
  -X POST $URL/inboxes/$INBOX/events/next
```

Every endpoint takes the session token you get from logging in.
