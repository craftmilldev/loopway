import { useEffect, type MouseEvent, type ReactNode } from "react";
import { logout, type Me } from "./lw.js";
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

/** Nav for signed-in pages: optional links, then who you are and a log-out link. */
export function UserNav({ me, children }: { me: Me | null; children?: ReactNode }) {
  const out = (e: MouseEvent) => {
    e.preventDefault();
    logout();
  };
  return (
    <>
      {children}
      <span>{me ? me.email || me.name : ""}</span>
      <a href="#" onClick={out}>
        Log out
      </a>
    </>
  );
}

/** Links to the dashboard's sections. */
export function DashNav({ me, children }: { me: Me | null; children?: ReactNode }) {
  return (
    <UserNav me={me}>
      {children}
      <a href="/dashboard#bots">Bots</a>
      <a href="/dashboard#runners">Runners</a>
      <a href="/dashboard#inboxes">Inboxes</a>
    </UserNav>
  );
}
