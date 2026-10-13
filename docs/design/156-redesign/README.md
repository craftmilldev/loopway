# Dashboard redesign (#156)

The page designs for [#156](https://github.com/craftmilldev/loopway/issues/156). They are reference, not code to ship: build the pages in `packages/web/client` with the app's own components and `styles.css`, and match these for layout, copy and hierarchy.

| Page | Route | Static HTML | Screenshot | Source |
| --- | --- | --- | --- | --- |
| Overview | `/dashboard` | [overview.html](overview.html) | [img/overview.png](img/overview.png) | [source/Main.dc.html](source/Main.dc.html) |
| Bots | `/dashboard/bots` | [bots.html](bots.html) | [img/bots.png](img/bots.png) | [source/Bots.dc.html](source/Bots.dc.html) |
| Bot, activity | `/dashboard/bots/:botId` | [bot.html](bot.html) | [img/bot.png](img/bot.png) | [source/Bot.dc.html](source/Bot.dc.html) |
| Bot, prompt and rules | `/dashboard/bots/:botId/prompt` | [prompt-and-rules.html](prompt-and-rules.html) | [img/prompt-and-rules.png](img/prompt-and-rules.png) | [source/Prompt.dc.html](source/Prompt.dc.html) |
| Thread | `/dashboard/bots/:botId/threads/:threadId` | [thread.html](thread.html) | [img/thread.png](img/thread.png) | [source/Thread.dc.html](source/Thread.dc.html) |
| New bot | `/dashboard/bots/new` | [new-bot.html](new-bot.html) | [img/new-bot.png](img/new-bot.png) | [source/Onboard.dc.html](source/Onboard.dc.html) |
| Inboxes | `/dashboard/inboxes` | [inboxes.html](inboxes.html) | [img/inboxes.png](img/inboxes.png) | [source/Inboxes.dc.html](source/Inboxes.dc.html) |
| Alerts | not built, see #157 | [alerts.html](alerts.html) | [img/alerts.png](img/alerts.png) | [source/Alerts.dc.html](source/Alerts.dc.html) |

## Reading them

- **Static HTML** (`*.html`) is the easiest to read and to open in a browser: plain markup, inline styles, links between pages working. It loads `ds/craftmill/tokens.css` (the same Craftmill tokens `client/styles.css` already declares) and the two Google Fonts.
- **Screenshots** (`img/*.png`) are those pages at 1440 px wide, from headless Chrome.
- **Source** (`source/*.dc.html`) is what the design canvas edits. `<sc-for list="{{xs}}" as="x">` repeats, `<sc-if value="{{c}}">` branches, and `{{x.y}}` reads from what `renderVals()` returns in the script at the bottom of each file. Use it when the static page loses something, like the selected state on the new-bot form.

To compare a page with what you built:

```bash
git fetch origin design/156-redesign
git worktree add /tmp/design-156 origin/design/156-redesign
open /tmp/design-156/docs/design/156-redesign/bot.html
```

## The data in them is made up

Names come from this repo (`dev`, `loopway-github`, #155, #149), but every count, time and chart is sample data. Where a figure needs a query the API doesn't have yet, #156 says so.
