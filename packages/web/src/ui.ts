import { readFile } from "node:fs/promises";
import { Hono } from "hono";

// The web UI is a React app in client/ that talks to the JSON API on the same origin. scripts/client.ts bundles it
// into public/app.js and public/app.css. This module returns the HTML shell that loads the bundle, and serves the
// bundle itself: Vercel's CDN only serves the public/ files that are committed (the icons), not ones the build
// writes. The URLs are literal so Vercel's file tracing ships both files with the function.

const FONTS =
  "https://fonts.googleapis.com/css2?family=Sorts+Mill+Goudy:ital@0;1&family=Courier+Prime:ital,wght@0,400;0,700;1,400&display=swap";

const shell = (posthogMeta: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>loopway</title>
${posthogMeta}
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONTS}" rel="stylesheet">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="/app.js"></script>
</body>
</html>`;

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// The project key is public by design: the browser needs it to send events.
function posthogMeta(key: string | undefined, uiHost: string | undefined) {
  if (!key) return "";
  const ui = uiHost ? `\n<meta name="posthog-ui-host" content="${escapeAttr(uiHost)}">` : "";
  return `<meta name="posthog-key" content="${escapeAttr(key)}">${ui}`;
}

const BUNDLE = {
  "/app.js": { url: new URL("../public/app.js", import.meta.url), type: "text/javascript; charset=utf-8" },
  "/app.css": { url: new URL("../public/app.css", import.meta.url), type: "text/css; charset=utf-8" },
};

export interface WebOptions {
  /** PostHog project key for the browser. Unset, the UI sends no metrics. */
  posthogKey?: string;
  /** Where PostHog's own UI lives, for links from the browser. Optional. */
  posthogUiHost?: string;
}

export function createWeb(opts: WebOptions = {}) {
  const app = new Hono();
  const html = shell(posthogMeta(opts.posthogKey, opts.posthogUiHost));
  const pages = [
    "/",
    "/login",
    "/dashboard",
    "/dashboard/bots",
    "/dashboard/bots/new",
    "/dashboard/bots/:botId",
    "/dashboard/bots/:botId/prompt",
    "/dashboard/bots/:botId/threads/:threadId",
    "/dashboard/inboxes",
    "/dashboard/inboxes/:inboxId",
  ];
  for (const path of pages) app.get(path, (c) => c.html(html));
  // The inbox page used to live at /dashboard/<id>.
  app.get("/dashboard/:inboxId", (c) => c.redirect("/dashboard/inboxes/" + c.req.param("inboxId")));
  for (const [path, { url, type }] of Object.entries(BUNDLE)) {
    app.get(path, async (c) => {
      const body = await readFile(url).catch(() => undefined);
      if (!body) return c.notFound(); // not built yet
      return c.body(body, 200, { "content-type": type });
    });
  }
  return app;
}
