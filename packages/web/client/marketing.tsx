import { useEffect } from "react";
import home from "../content/home.md";
import { MARKETING_PATHS, type MarketingPath } from "../src/marketing.js";
import { LandingSections, parseHome, type Section } from "./landing.js";
import { Wordmark } from "./layout.js";
import { lastOrgPath, token } from "./lw.js";
import { track } from "./metrics.js";

// The markdown for each marketing page, keyed by path. Typed on the path list in src/marketing.ts, so a path added
// there doesn't compile until its content is here.
export const CONTENT: Record<MarketingPath, string> = {
  "/": home,
};

/** The sections the top bar links to, by id; each link reads as its section's label. */
const NAV = ["levels", "bots", "how", "dashboard", "sources"];

function Marketing({ sections }: { sections: Section[] }) {
  useEffect(() => {
    document.title = "loopway";
  }, []);
  const account = token() ? <a href={lastOrgPath()}>Dashboard</a> : <a href="/login">Log in</a>;
  return (
    <>
      <header className="lp-masthead">
        <div className="lp-masthead-row">
          <Wordmark href="/" />
          <nav className="lp-nav" aria-label="Main">
            {NAV.map((id) => sections.find((s) => s.id === id))
              .filter((s) => s !== undefined)
              .map((s) => (
                <a
                  key={s.id}
                  href={"#" + s.id}
                  onClick={() => track("landing_link_clicked", { section: s.id, kind: "nav", to: "anchor" })}
                >
                  {s.label}
                </a>
              ))}
            {account}
          </nav>
        </div>
      </header>
      <main className="lp">
        <LandingSections sections={sections} />
      </main>
    </>
  );
}

/** The marketing page at this path, the same whether or not the visitor is signed in; null if there isn't one. */
export function marketingPage(path: string) {
  if (!(MARKETING_PATHS as readonly string[]).includes(path)) return null;
  return <Marketing sections={parseHome(CONTENT[path as MarketingPath])} />;
}
