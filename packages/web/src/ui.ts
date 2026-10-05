import { Hono } from "hono";

// The web UI: static HTML shells plus a little vanilla JS that talks to the JSON API on the same origin with the
// session token kept in localStorage. Styles are copied from craftmilldev/craftmill.dev.

const STYLES = `/* Craftmill — paper and ink. Tokens and base styles copied from craftmilldev/craftmill.dev (src/styles.css). */

:root{
  --paper-100:#f2eede;
  --paper-200:#e4ddc9;
  --paper-300:#d6cdb4;

  --ink-900:#16130e;
  --ink-800:#241f17;
  --ink-700:#3a352b;
  --ink-600:#4b4534;
  --ink-500:#5c5544;
  --ink-400:#6d6656;
  --ink-300:#8b8471;
  --ink-200:#a9a28c;

  --madder-700:#7a1f12;
  --madder-600:#9e2b1c;
  --madder-500:#b8412c;
  --madder-300:#d08a76;

  --rule-hair:rgba(22,19,14,.16);
  --rule-soft:rgba(22,19,14,.32);
  --rule-strong:var(--ink-900);

  --font-text:'Sorts Mill Goudy',Georgia,'Times New Roman',serif;
  --font-type:'Courier Prime',Courier,ui-monospace,monospace;

  --control-sm:28px;
  --control-lg:44px;

  --measure-page:1100px;
}

*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper-200);color:var(--ink-700);font-family:var(--font-text);font-size:17px;line-height:1.5;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:var(--font-text);font-weight:400;letter-spacing:-.021em;line-height:1.16;color:var(--ink-900);margin:0}
h1{line-height:1.02}
p{margin:0}
a{color:var(--madder-600);text-decoration:none}
a:hover{color:#7a2013}
img{max-width:100%}
::selection{background:var(--ink-900);color:var(--paper-100)}
:focus-visible{outline:2px solid var(--madder-600);outline-offset:2px}

.eyebrow{font-family:var(--font-type);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--madder-600)}

/* Masthead */
.masthead{max-width:var(--measure-page);margin:0 auto;padding:24px 24px 16px;text-align:center}
.masthead-row{display:flex;align-items:center;gap:24px}
.masthead-rule{flex:1;height:0;min-width:0;border-top:3px double var(--ink-900)}
.masthead-word{font-size:clamp(1.375rem,8.5vw,3.75rem);letter-spacing:.15em;line-height:1;color:var(--ink-900);text-indent:.15em;white-space:nowrap}
.masthead-word-sm{font-size:clamp(1.125rem,5.5vw,2.25rem)}
.masthead-tag{font-family:var(--font-type);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-400);padding-top:8px}
@media (max-width:480px){
  .masthead-rule{display:none}
  .masthead-tag{font-size:9px;letter-spacing:.1em}
}

/* Nav */
.nav{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;max-width:var(--measure-page);margin:0 auto;padding:0 24px 16px;border-bottom:3px double var(--ink-900);font-family:var(--font-type);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-400)}
.nav a{color:var(--ink-400)}
.nav .current{color:var(--ink-900);text-decoration:underline;text-underline-offset:3px}
.nav-spacer{flex:1}
@media (max-width:640px){
  .nav{padding-bottom:20px}
  .nav-spacer{flex-basis:100%;height:0}
}

/* Simple header bar */
.post-nav{display:flex;align-items:center;gap:20px;max-width:var(--measure-page);margin:0 auto;padding:16px 24px 8px;border-bottom:3px double var(--ink-900);font-family:var(--font-type);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-400)}
.post-nav .wordmark{color:var(--ink-900);letter-spacing:.15em;font-family:var(--font-text);font-size:1.25rem}
.post-nav .wordmark:hover{color:var(--ink-900)}

/* Buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:var(--control-lg);padding:0 24px;font-family:var(--font-type);font-size:13px;font-weight:400;text-transform:uppercase;letter-spacing:.12em;border:0;border-radius:0;cursor:pointer;text-decoration:none;white-space:nowrap;background:var(--ink-900);color:var(--paper-100);transition:background .15s ease}
.btn:hover{background:var(--ink-800);color:var(--paper-100)}
.btn-sm{height:var(--control-sm);padding:0 12px;font-size:11px}
.btn-md{height:36px;padding:0 16px;font-size:12px}

/* Forms */
.field{display:flex;flex-direction:column;gap:8px}
.field+.field{margin-top:20px}
.field label{display:block;padding-bottom:3px;border-bottom:1px solid var(--rule-hair);font-family:var(--font-type);font-size:.6875rem;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-600)}
.field .hint{font-size:.8125rem;color:var(--ink-500);margin:0}
.input-wrap{display:flex;align-items:center;gap:8px;height:var(--control-lg);padding:0 8px;background:var(--paper-100)}
.input-wrap input,.input-wrap select{flex:1;min-width:0;height:100%;border:0;border-bottom:1px solid var(--rule-soft);outline:none;background:transparent;color:var(--ink-900);font-family:var(--font-type);font-size:.8125rem}
.input-wrap input:focus,.input-wrap select:focus{border-bottom:2px solid var(--madder-600)}
.form-actions{display:flex;gap:12px;margin-top:20px}
.btn-quiet{background:transparent;color:var(--ink-900);box-shadow:inset 0 0 0 1px var(--ink-900)}
.btn-quiet:hover{background:var(--paper-300);color:var(--ink-900)}
.error{margin-top:16px;font-family:var(--font-type);font-size:.8125rem;color:var(--madder-700)}

/* Pages */
main{max-width:var(--measure-page);margin:0 auto;padding:32px 24px 64px}
.prose{max-width:66ch;margin:0 auto}
.prose h1{font-size:clamp(1.75rem,4vw,2.75rem)}
.prose h2{margin-top:36px;font-size:1.5rem}
.prose p,.prose ol,.prose ul{margin:14px 0 0;line-height:1.6}
.prose li+li{margin-top:6px}
pre,code{font-family:var(--font-type);font-size:.8125rem}
pre{margin:14px 0 0;padding:12px 16px;background:var(--paper-100);border-left:3px solid var(--ink-900);overflow-x:auto;line-height:1.5}
.narrow{max-width:420px;margin:0 auto}
.page-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;padding-bottom:12px;border-bottom:1px solid var(--ink-900)}
.page-head h1{font-size:clamp(1.5rem,3vw,2.25rem)}
.muted{color:var(--ink-400)}
.list{margin:0;padding:0;list-style:none}
.list>li{padding:16px 0;border-bottom:1px solid var(--rule-hair)}
.list .title{font-size:1.1875rem}
.list .meta{margin-top:4px;font-family:var(--font-type);font-size:.75rem;color:var(--ink-400);word-break:break-all}
.panel{margin-top:24px;padding:20px;background:var(--paper-100)}
.toolbar{display:flex;align-items:center;gap:16px;margin-top:16px;font-family:var(--font-type);font-size:.75rem;text-transform:uppercase;letter-spacing:.1em}
.toolbar label{display:flex;align-items:center;gap:8px;cursor:pointer}
details.event{padding:12px 0;border-bottom:1px solid var(--rule-hair)}
details.event summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:4px 16px;align-items:baseline}
details.event .type{font-family:var(--font-type);font-size:.8125rem;color:var(--ink-900)}
details.event .badge{font-family:var(--font-type);font-size:.6875rem;letter-spacing:.1em;text-transform:uppercase;color:var(--madder-600)}
details.event .badge.done{color:var(--ink-300)}
details.event .when{margin-left:auto;font-family:var(--font-type);font-size:.75rem;color:var(--ink-400)}
details.event pre{max-height:480px;overflow:auto}
[hidden]{display:none!important}
`;

const FONTS =
  "https://fonts.googleapis.com/css2?family=Sorts+Mill+Goudy:ital@0;1&family=Courier+Prime:ital,wght@0,400;0,700;1,400&display=swap";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

interface PageOptions {
  title: string;
  body: string;
  script?: string;
  /** Nav links shown on the right. */
  nav?: string;
}

function page({ title, body, script, nav }: PageOptions) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONTS}" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<nav class="post-nav"><a class="wordmark" href="/">loopway</a><span class="nav-spacer" style="flex:1"></span>${nav ?? ""}</nav>
<main>
${body}
</main>
<script src="/app.js"></script>
${script ? `<script>\n${script}\n</script>` : ""}
</body>
</html>`;
}

const HOME = page({
  title: "loopway",
  nav: `<a id="nav-cta" href="/login">Log in</a>`,
  script: `
    if (lw.token()) { const a = document.getElementById("nav-cta"); a.href = "/dashboard"; a.textContent = "Dashboard"; }
  `,
  body: `<div class="prose">
<p class="eyebrow">webhooks in, a queue out</p>
<h1>loopway</h1>
<p>loopway catches webhooks and keeps them in an inbox as <a href="https://github.com/cloudevents/spec">CloudEvents</a>. A script, a cron job or an agent then claims events one at a time, works on them, and marks them done.</p>

<h2>Use it</h2>
<ol>
<li><a href="/login">Log in</a> with your email. New emails get an account.</li>
<li>Create an inbox from the <a href="/dashboard">dashboard</a>. It gives you a webhook URL.</li>
<li>Paste that URL and your secret into the webhook settings of the service that sends events (GitHub is the first source).</li>
<li>Pull work from the inbox with the CLI or the API.</li>
</ol>

<h2>The CLI</h2>
<pre>loopway login
loopway inbox list
loopway events list &lt;inbox&gt; --status pending
loopway events next &lt;inbox&gt; --json
loopway events done &lt;inbox&gt; &lt;event&gt;</pre>
<p><code>next</code> locks the oldest pending event for you. If you stop, the lock expires and the event goes back in the queue.</p>

<h2>The API</h2>
<pre>curl -H "Authorization: Bearer $TOKEN" \\
  -X POST $URL/inboxes/$INBOX/events/next</pre>
<p>Every endpoint takes the session token you get from logging in.</p>
</div>`,
});

const LOGIN = page({
  title: "Log in · loopway",
  nav: `<a href="/">Home</a>`,
  script: `
    const form = document.getElementById("form"), err = document.getElementById("err");
    const emailIn = document.getElementById("email"), codeField = document.getElementById("code-field"), codeIn = document.getElementById("code");
    const btn = document.getElementById("go");
    let step = "email";
    const fail = (m) => { err.textContent = m; err.hidden = false; };

    // A stored token that still works skips the form; a stale one is dropped quietly.
    (async () => {
      if (!lw.token()) return;
      const r = await lw.api("/me").catch(() => null);
      if (r && r.ok) location.replace("/dashboard"); else lw.clear();
    })();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      try {
        if (step === "email") {
          const r = await lw.api("/auth/login", { method: "POST", body: { email: emailIn.value }, auth: false });
          if (!r.ok) return fail(await lw.message(r));
          step = "code";
          emailIn.readOnly = true;
          codeField.hidden = false;
          codeIn.required = true;
          codeIn.focus();
          btn.textContent = "Verify";
          document.getElementById("sent").hidden = false;
        } else {
          const r = await lw.api("/auth/verify", { method: "POST", body: { email: emailIn.value, code: codeIn.value }, auth: false });
          if (!r.ok) return fail(await lw.message(r));
          lw.save((await r.json()).token);
          location.replace("/dashboard");
        }
      } catch { fail("Could not reach the server."); }
      finally { btn.disabled = false; }
    });
  `,
  body: `<div class="narrow">
<p class="eyebrow">log in</p>
<h1>Log in</h1>
<p id="sent" class="hint muted" hidden style="margin-top:12px">If that address can receive mail, a code is on its way.</p>
<form id="form" style="margin-top:24px">
  <div class="field"><label for="email">Email</label><div class="input-wrap"><input id="email" type="email" required autocomplete="email" autofocus></div></div>
  <div class="field" id="code-field" hidden><label for="code">Login code</label><div class="input-wrap"><input id="code" autocomplete="one-time-code" autocapitalize="characters"></div></div>
  <div class="form-actions"><button id="go" class="btn" type="submit">Send code</button></div>
  <p id="err" class="error" hidden></p>
</form>
</div>`,
});

const DASHBOARD = page({
  title: "Inboxes · loopway",
  nav: `<span id="who"></span><a href="#" id="logout">Log out</a>`,
  script: `
    lw.guard().then((me) => {
      if (!me) return;
      document.getElementById("who").textContent = me.email || me.name;
      load();
    });
    document.getElementById("logout").addEventListener("click", (e) => { e.preventDefault(); lw.clear(); location.replace("/login"); });

    const list = document.getElementById("list"), empty = document.getElementById("empty");
    async function load() {
      const r = await lw.api("/inboxes");
      if (!r.ok) return lw.expired(r);
      const { data } = await r.json();
      list.replaceChildren(...data.map((i) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.className = "title"; a.href = "/dashboard/" + i.id; a.textContent = i.name;
        const meta = document.createElement("div");
        meta.className = "meta"; meta.textContent = i.source_type + " · " + i.webhook_url;
        li.append(a, meta);
        return li;
      }));
      empty.hidden = data.length > 0;
    }

    const panel = document.getElementById("create"), form = document.getElementById("form"), err = document.getElementById("err");
    const source = document.getElementById("source");
    document.getElementById("new").addEventListener("click", async () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden && !source.options.length) {
        const r = await lw.api("/sources");
        if (r.ok) for (const s of (await r.json()).data) source.add(new Option(s.type, s.type));
      }
    });
    document.getElementById("gen").addEventListener("click", () => {
      const b = crypto.getRandomValues(new Uint8Array(24));
      document.getElementById("secret").value = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const events = document.getElementById("events").value.split(",").map((s) => s.trim()).filter(Boolean);
      const r = await lw.api("/inboxes", { method: "POST", body: {
        name: document.getElementById("name").value,
        source_type: source.value,
        config: { events, secret: document.getElementById("secret").value },
      } });
      if (r.status === 401) return lw.expired(r);
      if (!r.ok) { err.textContent = await lw.message(r); err.hidden = false; return; }
      form.reset();
      panel.hidden = true;
      load();
    });
  `,
  body: `<div class="page-head"><h1>Inboxes</h1><button id="new" class="btn btn-md" type="button">New inbox</button></div>
<form id="create" class="panel" hidden>
  <div class="field"><label for="name">Name</label><div class="input-wrap"><input id="name" required maxlength="200"></div></div>
  <div class="field"><label for="source">Source</label><div class="input-wrap"><select id="source" required></select></div></div>
  <div class="field"><label for="events">Events</label><div class="input-wrap"><input id="events" required placeholder="push, pull_request, issues"></div><p class="hint">Comma separated. Use * for everything.</p></div>
  <div class="field"><label for="secret">Secret</label><div class="input-wrap"><input id="secret" required minlength="16" autocomplete="off"><button id="gen" class="btn btn-sm btn-quiet" type="button">Generate</button></div><p class="hint">At least 16 characters. You enter the same secret in the sender's webhook settings.</p></div>
  <div class="form-actions"><button class="btn" type="submit">Create inbox</button></div>
  <p id="err" class="error" hidden></p>
</form>
<ul id="list" class="list"></ul>
<p id="empty" class="muted" hidden style="margin-top:24px">No inboxes yet.</p>`,
});

const INBOX = page({
  title: "Inbox · loopway",
  nav: `<a href="/dashboard">Inboxes</a><span id="who"></span><a href="#" id="logout">Log out</a>`,
  script: `
    const id = location.pathname.split("/").pop();
    document.getElementById("logout").addEventListener("click", (e) => { e.preventDefault(); lw.clear(); location.replace("/login"); });
    const list = document.getElementById("events"), more = document.getElementById("more"), empty = document.getElementById("empty");
    const hide = document.getElementById("hide");
    let cursor = null;

    lw.guard().then(async (me) => {
      if (!me) return;
      document.getElementById("who").textContent = me.email || me.name;
      const r = await lw.api("/inboxes/" + encodeURIComponent(id));
      if (r.status === 404) return (document.getElementById("title").textContent = "Inbox not found");
      if (!r.ok) return lw.expired(r);
      const inbox = await r.json();
      document.getElementById("title").textContent = inbox.name;
      document.getElementById("meta").textContent = inbox.source_type + " · " + inbox.webhook_url;
      reload();
    });

    hide.addEventListener("change", reload);
    more.addEventListener("click", () => load());
    function reload() { cursor = null; list.replaceChildren(); load(); }

    async function load() {
      const q = new URLSearchParams({ order: "desc", limit: "50", status: hide.checked ? "unprocessed" : "all" });
      if (cursor) q.set("cursor", cursor);
      const r = await lw.api("/inboxes/" + encodeURIComponent(id) + "/events?" + q);
      if (!r.ok) return lw.expired(r);
      const body = await r.json();
      for (const e of body.data) list.append(row(e));
      cursor = body.next_cursor;
      more.hidden = !cursor;
      empty.hidden = list.children.length > 0;
    }

    function row(e) {
      const d = document.createElement("details");
      d.className = "event";
      const s = document.createElement("summary");
      const type = document.createElement("span"); type.className = "type"; type.textContent = e.event.type;
      const subject = document.createElement("span"); subject.className = "muted"; subject.textContent = e.event.subject || "";
      const badge = document.createElement("span");
      badge.className = "badge" + (e.status === "processed" ? " done" : ""); badge.textContent = e.status;
      const when = document.createElement("span"); when.className = "when"; when.textContent = new Date(e.received_at).toLocaleString();
      s.append(type, subject, badge, when);
      const pre = document.createElement("pre"); pre.textContent = JSON.stringify(e.event, null, 2);
      d.append(s, pre);
      return d;
    }
  `,
  body: `<div class="page-head"><div><h1 id="title">Inbox</h1><div id="meta" class="muted" style="font-family:var(--font-type);font-size:.75rem;word-break:break-all"></div></div></div>
<div class="toolbar"><label><input id="hide" type="checkbox"> Hide processed</label></div>
<div id="events"></div>
<p id="empty" class="muted" hidden style="margin-top:24px">No events.</p>
<div class="form-actions"><button id="more" class="btn btn-md btn-quiet" type="button" hidden>Load older</button></div>`,
});

// Shared client helpers, exposed to the page scripts as `lw`.
const APP_JS = `(() => {
  const KEY = "loopway_token";
  const get = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const lw = {
    token: get,
    save(t) { try { localStorage.setItem(KEY, t); } catch {} },
    clear() { try { localStorage.removeItem(KEY); } catch {} },
    api(path, { method = "GET", body, auth = true } = {}) {
      const headers = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (auth && get()) headers.authorization = "Bearer " + get();
      return fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    },
    async message(r) {
      try { return (await r.json()).error.message; } catch { return "Something went wrong (" + r.status + ")."; }
    },
    // An expired or invalid token is dropped quietly and the user lands on the login page.
    expired(r) {
      if (r.status === 401) { lw.clear(); location.replace("/login"); }
    },
    async guard() {
      if (!get()) { location.replace("/login"); return null; }
      const r = await lw.api("/me").catch(() => null);
      if (!r || !r.ok) { if (r) lw.expired(r); return null; }
      return r.json();
    },
  };
  window.lw = lw;
})();`;

export function createWeb() {
  const app = new Hono();
  app.get("/", (c) => c.html(HOME));
  app.get("/login", (c) => c.html(LOGIN));
  app.get("/dashboard", (c) => c.html(DASHBOARD));
  app.get("/dashboard/:inboxId", (c) => c.html(INBOX));
  app.get("/styles.css", (c) => c.body(STYLES, 200, { "content-type": "text/css; charset=utf-8" }));
  app.get("/app.js", (c) => c.body(APP_JS, 200, { "content-type": "text/javascript; charset=utf-8" }));
  return app;
}
