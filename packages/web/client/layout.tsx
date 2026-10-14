import { createContext, useContext, useEffect, type MouseEvent, type ReactNode } from "react";
import { logout, orgBase, orgSlug, useMe, type Me, type Org } from "./lw.js";
import { OrgSwitcher } from "./org-switcher.js";
import wordmark from "./wordmark.svg";

export function Layout({ title, nav, children }: { title: string; nav?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    document.title = title;
  }, [title]);
  return (
    <>
      <nav className="post-nav">
        <a className="wordmark" href="/" dangerouslySetInnerHTML={{ __html: wordmark }} />
        <span className="eyebrow">build bots, work with them</span>
        <span className="nav-spacer" style={{ flex: 1 }}></span>
        {nav}
      </nav>
      <main>{children}</main>
    </>
  );
}

/** The user's orgs, which the page's org gate (main.tsx) has loaded; null where there is no gate. */
export const OrgsContext = createContext<Org[] | null>(null);

/** The tabs of an org's pages: where each goes, and whether the path `p` is on it. */
const sections = (base: string) => [
  { label: "Overview", href: base, on: (p: string) => p === base },
  { label: "Bots", href: base + "/bots", on: (p: string) => p.startsWith(base + "/bots") },
  { label: "Inboxes", href: base + "/inboxes", on: (p: string) => p.startsWith(base + "/inboxes") },
  { label: "Runners", href: base + "#runners", on: () => false },
];

/** Frame of every signed-in page: the masthead, then the page at dashboard width. `crumb` sits above the page. */
export function DashLayout({
  title,
  me,
  crumb,
  children,
}: {
  title: string;
  me: Me | null;
  crumb?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    document.title = title;
  }, [title]);
  const orgs = useContext(OrgsContext);
  const base = orgBase();
  const out = (e: MouseEvent) => {
    e.preventDefault();
    logout();
  };
  return (
    <>
      <header className="dash-head">
        <div className="dash-head-row">
          <a className="dash-word" href={base}>
            LOOPWAY
          </a>
          <div className="dash-head-side">
            {orgs && <OrgSwitcher orgs={orgs} current={orgSlug()} />}
            <span className="dash-account">{me ? me.username || me.email || me.name : ""}</span>
            <a href="#" onClick={out}>
              Log out
            </a>
            <a className="btn btn-md" href={base + "/bots/new"}>
              New bot
            </a>
          </div>
        </div>
        <nav className="dash-nav" aria-label="Main">
          {sections(base).map((s) => (
            <a key={s.label} href={s.href} className={s.on(location.pathname) ? "on" : undefined}>
              {s.label}
            </a>
          ))}
        </nav>
      </header>
      <main className="dash">
        {crumb}
        {children}
      </main>
    </>
  );
}

/** Stands in for a dashboard page that isn't built yet. */
export function Placeholder({ title }: { title: string }) {
  const me = useMe();
  return (
    <DashLayout title={title + " · loopway"} me={me}>
      <div className="page-head">
        <h1>{title}</h1>
      </div>
      <p className="muted" style={{ marginTop: 24 }}>
        Coming soon.
      </p>
    </DashLayout>
  );
}
