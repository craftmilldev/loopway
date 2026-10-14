import { useEffect, type MouseEvent, type ReactNode } from "react";
import { logout, useMe, type Me } from "./lw.js";
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

const SECTIONS = [
  { label: "Overview", href: "/dashboard", on: (p: string) => p === "/dashboard" },
  { label: "Bots", href: "/dashboard/bots", on: (p: string) => p.startsWith("/dashboard/bots") },
  { label: "Inboxes", href: "/dashboard/inboxes", on: (p: string) => p.startsWith("/dashboard/inboxes") },
  { label: "Runners", href: "/dashboard#runners", on: () => false },
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
  const out = (e: MouseEvent) => {
    e.preventDefault();
    logout();
  };
  return (
    <>
      <header className="dash-head">
        <div className="dash-head-row">
          <a className="dash-word" href="/dashboard">
            LOOPWAY
          </a>
          <div className="dash-head-side">
            <span className="dash-account">{me ? me.username || me.email || me.name : ""}</span>
            <a href="#" onClick={out}>
              Log out
            </a>
            <a className="btn btn-md" href="/dashboard/bots/new">
              New bot
            </a>
          </div>
        </div>
        <nav className="dash-nav" aria-label="Main">
          {SECTIONS.map((s) => (
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
