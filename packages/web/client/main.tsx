import { createRoot } from "react-dom/client";
import { Dashboard } from "./dashboard.js";
import { Home } from "./home.js";
import { Inbox } from "./inbox.js";
import { Login } from "./login.js";
import "./styles.css";

// One bundle for every page. The server sends the same HTML shell for each route (src/ui.ts) and links between
// pages are plain full-page loads, so picking the page from the path is all the routing there is.
function page(path: string) {
  if (path === "/") return <Home />;
  if (path === "/login") return <Login />;
  if (path === "/dashboard") return <Dashboard />;
  const inbox = path.match(/^\/dashboard\/([^/]+)$/);
  if (inbox) return <Inbox id={decodeURIComponent(inbox[1]!)} />;
  return null;
}

createRoot(document.getElementById("root")!).render(page(location.pathname));
