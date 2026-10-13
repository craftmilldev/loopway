import { createRoot } from "react-dom/client";
import { Bot, Thread } from "./bot.js";
import { Bots } from "./bots.js";
import { NewBot } from "./dashboard.js";
import { Home } from "./home.js";
import { Inbox } from "./inbox.js";
import { Inboxes } from "./inboxes.js";
import { Login } from "./login.js";
import { startMetrics } from "./metrics.js";
import { Overview } from "./overview.js";
import "./styles.css";

// One bundle for every page. The server sends the same HTML shell for each route (src/ui.ts) and links between
// pages are plain full-page loads, so picking the page from the path is all the routing there is.
function page(path: string) {
  if (path === "/") return <Home />;
  if (path === "/login") return <Login />;
  if (path === "/dashboard") return <Overview />;
  if (path === "/dashboard/bots") return <Bots />;
  if (path === "/dashboard/bots/new") return <NewBot />;
  if (path === "/dashboard/inboxes") return <Inboxes />;
  const part = (m: RegExpMatchArray, i: number) => decodeURIComponent(m[i]!);
  const inbox = path.match(/^\/dashboard\/inboxes\/([^/]+)$/);
  if (inbox) return <Inbox id={part(inbox, 1)} />;
  const thread = path.match(/^\/dashboard\/bots\/([^/]+)\/threads\/([^/]+)$/);
  if (thread) return <Thread botId={part(thread, 1)} id={part(thread, 2)} />;
  const prompt = path.match(/^\/dashboard\/bots\/([^/]+)\/prompt$/);
  if (prompt) return <Bot id={part(prompt, 1)} view="prompt" />;
  const bot = path.match(/^\/dashboard\/bots\/([^/]+)$/);
  if (bot) return <Bot id={part(bot, 1)} />;
  return null;
}

startMetrics();
createRoot(document.getElementById("root")!).render(page(location.pathname));
