# Zero state redesign: mockups

A throwaway branch holding design mockups, not app code. Do not merge it; the work it describes is
tracked on the Linear issues labelled `loopway` titled "Redesign the zero state" and "Send a test
message to an inbox".

Four screens of the zero state, one file each. They are Design-canvas `.dc.html` files, but the markup
inside `<x-dc>` is plain HTML with inline styles, so each opens in a browser as a static page (the
canvas runtime `support.js` and the river-toile watermark are not included, and nothing depends on them).

| File | Screen |
| --- | --- |
| `Main.dc.html` | Step 1: get loopway running (three commands, waiting line) |
| `Step2.dc.html` | Step 2: make your first bot (agent prompt beside the CLI by hand) |
| `Step3.dc.html` | Step 3: see it run (send a test message, or add the webhook in GitHub) |
| `Done.dc.html` | The celebration: a ledger of what was set up |

`ds/craftmill/tokens.css` holds the Craftmill design tokens the screens use: paper, ink, madder and
indigo; Sorts Mill Goudy for everything read, Courier Prime for everything operated; zero radius;
rules instead of boxes. `canvas.json` is the canvas index and can be ignored.
