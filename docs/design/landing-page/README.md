# Landing page redesign

The design for the new home page at `/`. It's reference, not code to ship: build the page in `packages/web/client` with the app's own `styles.css`, and match this for layout, hierarchy and color.

| What | File |
| --- | --- |
| Every word on the page, as markdown | [home.md](home.md) |
| Static HTML, open it in a browser | [landing.html](landing.html) |
| Screenshot at 1440 px | [img/landing.png](img/landing.png) |
| Design canvas source | [canvas/Main.dc.html](canvas/Main.dc.html) |

## The words live in home.md

[home.md](home.md) holds all the prose, and its comment at the top says how the page reads it: `##` starts a section, `#`/`###` is its heading, lists are its columns. It replaces `packages/web/content/home.md`, so the words can be changed without touching the page code. The sample data in the figures (the terminal, the thread, the bots table) is not prose and stays in the page code.

## Status colors are the dashboard's

The site, the dashboard and the terminal (`loopway bots run`) use one set of status colors. The dashboard's (`.state`, `.dot` and `LevelPie` in `packages/web/client`) are the source; this design uses exactly those on paper. On a dark ground (the terminal, an ink panel) the 600 steps don't have the contrast to read, so each one has a lighter step from the same ramp.

| Meaning | On paper: dashboard, site | On ink: terminal, ink panels |
| --- | --- | --- |
| `working` | indigo-600 `#2c4a53` | indigo-200 `#9db4ba` |
| `limited`, `stranded` | madder-600 `#9e2b1c` | madder-300 `#d08a76` |
| `waiting`, `idle` | ink-500 `#5c5544` | ink-200 `#a9a28c` |
| Level 2 | ink-300 `#8b8471` | ink-300 `#8b8471` |
| Level 3 | indigo-600 `#2c4a53` | indigo-200 `#9db4ba` |
| Level 4 | madder-600 `#9e2b1c` | madder-300 `#d08a76` |

A state badge is the dashboard's `.state`: an outline in the state's color, lowercase Courier at 10.5 px. A state dot is the dashboard's `.dot`.

## Reading the files

- **Static HTML** loads `ds/craftmill/tokens.css` (the same tokens `client/styles.css` declares), the two Google Fonts, and the wordmark from `packages/web/client/wordmark.svg`.
- **The canvas source** is what the design canvas edits. `<sc-for list="{{xs}}" as="x">` repeats and `{{x.y}}` reads from what `renderVals()` returns in the script at the bottom.

```bash
git fetch origin design/landing-page
git worktree add /tmp/design-landing origin/design/landing-page
open /tmp/design-landing/docs/design/landing-page/landing.html
```

## The data in it is made up

The bot, inbox and harness names are the ones we run, and the issue numbers are from this repo. Every count, time, chart and level split is sample data.
