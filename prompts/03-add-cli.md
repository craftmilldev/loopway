we need a CLI for this project. To do that, we need to convert this into a multi package project. The CLI will use the API to work with loopway. A user should be able to create and list inboxes via the CLI. For create, it should be an interactive TUI. The use should also be able to take all the actions related to reading from an inbox.

auth for the cli should be tracked in ~/.loopway/config.json.
