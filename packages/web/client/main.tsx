import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Bot, Thread } from "./bot.js";
import { Bots } from "./bots.js";
import { Inbox } from "./inbox.js";
import { Inboxes } from "./inboxes.js";
import { Login } from "./login.js";
import { marketingPage } from "./marketing.js";
import { MembersPage } from "./members.js";
import { NewBot } from "./new-bot.js";
import { NewOrg } from "./new-org.js";
import { DashboardRedirect, NotFound, OrgGate } from "./org-pages.js";
import { startMetrics } from "./metrics.js";
import { Overview } from "./overview.js";
import "./styles.css";

// One bundle for every page. The server sends the same HTML shell for each route (src/ui.ts) and links between
// pages are plain full-page loads, so picking the page from the path is all the routing there is. Signed-in pages are
// /<org-slug>/...; /dashboard/... is the old address of the same pages.
function page(path: string) {
  const marketing = marketingPage(path);
  if (marketing) return marketing;
  if (path === "/login") return <Login />;
  if (path === "/orgs/new") return <NewOrg />;
  const old = path.match(/^\/dashboard(\/.*)?$/);
  if (old) return <DashboardRedirect rest={old[1] ?? ""} />;
  const part = (m: RegExpMatchArray, i: number) => decodeURIComponent(m[i]!);
  // Everything else is a page of the org named by the first segment, which OrgGate checks before showing it.
  const org = (content: ReactNode) => <OrgGate>{content}</OrgGate>;
  const rest = path.match(/^\/[^/]+(\/.*)?$/)?.[1] ?? "";
  if (path.length > 1 && !rest) return org(<Overview />);
  if (rest === "/bots") return org(<Bots />);
  if (rest === "/bots/new") return org(<NewBot />);
  if (rest === "/inboxes") return org(<Inboxes />);
  if (rest === "/members") return org(<MembersPage />);
  const inbox = rest.match(/^\/inboxes\/([^/]+)$/);
  if (inbox) return org(<Inbox id={part(inbox, 1)} />);
  const thread = rest.match(/^\/bots\/([^/]+)\/threads\/([^/]+)$/);
  if (thread) return org(<Thread botId={part(thread, 1)} id={part(thread, 2)} />);
  const prompt = rest.match(/^\/bots\/([^/]+)\/prompt$/);
  if (prompt) return org(<Bot id={part(prompt, 1)} view="prompt" />);
  const bot = rest.match(/^\/bots\/([^/]+)$/);
  if (bot) return org(<Bot id={part(bot, 1)} />);
  return <NotFound />;
}

startMetrics();
createRoot(document.getElementById("root")!).render(page(location.pathname));
