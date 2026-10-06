import { Marked } from "marked";
import home from "../content/home.md";
import { Layout } from "./layout.js";
import { token } from "./lw.js";

// The homepage copy lives in content/home.md.
const html = new Marked().parse(home, { async: false });

export function Home() {
  const nav = token() ? <a href="/dashboard">Dashboard</a> : <a href="/login">Log in</a>;
  return (
    <Layout title="loopway" nav={nav}>
      <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
    </Layout>
  );
}
