import { createRoot } from "react-dom/client";
import { marketingPage } from "./marketing.js";
import { startMetrics } from "./metrics.js";
import "./styles.css";

// The one page there is. The server sends the same HTML shell for each marketing path (src/ui.ts).
startMetrics();
createRoot(document.getElementById("root")!).render(marketingPage(location.pathname));
