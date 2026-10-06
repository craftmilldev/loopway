import { Hono } from "hono";

// The web UI is a React app in client/ that talks to the JSON API on the same origin. scripts/client.ts bundles it
// into public/app.js and public/app.css; Vercel serves public/ from its CDN and scripts/dev.ts serves it locally.
// This module only returns the HTML shell that loads the bundle.

const FONTS =
  "https://fonts.googleapis.com/css2?family=Sorts+Mill+Goudy:ital@0;1&family=Courier+Prime:ital,wght@0,400;0,700;1,400&display=swap";

const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>loopway</title>
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

export function createWeb() {
  const app = new Hono();
  for (const path of ["/", "/login", "/dashboard", "/dashboard/:inboxId"]) app.get(path, (c) => c.html(SHELL));
  return app;
}
