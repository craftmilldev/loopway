import { Marked } from "marked";
import home from "../content/home.md";
import { MARKETING_PATHS, type MarketingPath } from "../src/marketing.js";
import { Layout } from "./layout.js";
import { token } from "./lw.js";

// The markdown for each marketing page, keyed by path. Typed on the path list in src/marketing.ts, so a path added
// there doesn't compile until its content is here.
export const CONTENT: Record<MarketingPath, string> = {
  "/": home,
};

function Marketing({ html }: { html: string }) {
  const nav = token() ? <a href="/dashboard">Dashboard</a> : <a href="/login">Log in</a>;
  return (
    <Layout title="loopway" nav={nav}>
      <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
    </Layout>
  );
}

/** The marketing page at this path, the same whether or not the visitor is signed in; null if there isn't one. */
export function marketingPage(path: string) {
  if (!(MARKETING_PATHS as readonly string[]).includes(path)) return null;
  const html = new Marked().parse(CONTENT[path as MarketingPath], { async: false });
  return <Marketing html={html} />;
}
