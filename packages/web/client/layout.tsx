import { createContext, useContext, useEffect, type MouseEvent, type ReactNode } from "react";
import { lastOrgPath, logout, orgBase, orgSlug, startOrg, useMe, type Me, type Org } from "./lw.js";
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

/** For an empty shared org's pages: teammates are added from the CLI. Nothing in a personal org, which has no members. */
export function MembersHint() {
  const orgs = useContext(OrgsContext);
  const org = orgs?.find((o) => o.slug === orgSlug());
  if (!org || org.personal) return null;
  return (
    <>
      {" "}
      Add teammates with <code>loopway orgs add-member {org.slug} &lt;email&gt;</code>.
    </>
  );
}

/** The tabs of an org's pages: where each goes, and whether the path `p` is on it. */
const sections = (base: string) => [
  { label: "Overview", href: base, on: (p: string) => p === base },
  { label: "Bots", href: base + "/bots", on: (p: string) => p.startsWith(base + "/bots") },
  { label: "Inboxes", href: base + "/inboxes", on: (p: string) => p.startsWith(base + "/inboxes") },
  { label: "Members", href: base + "/members", on: (p: string) => p === base + "/members" },
  { label: "Runners", href: base + "/runners", on: (p: string) => p === base + "/runners" },
];

/** Frame of every signed-in page: the masthead, then the page at dashboard width. `crumb` sits above the page. */
export function DashLayout({
  title,
  me,
  crumb,
  orgless,
  children,
}: {
  title: string;
  me: Me | null;
  crumb?: ReactNode;
  /** For a page with no org in its path (/orgs/new): links go to the user's last org and no tab is current. */
  orgless?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    document.title = title;
  }, [title]);
  const orgs = useContext(OrgsContext);
  const slug = orgless ? (orgs ? startOrg(orgs) : null) : orgSlug();
  const base = !orgless ? orgBase() : !orgs ? lastOrgPath() : slug ? "/" + encodeURIComponent(slug) : "/dashboard";
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
            {orgs && slug && <OrgSwitcher orgs={orgs} current={slug} />}
            <span className="dash-account">{me ? me.username || me.email || me.name : ""}</span>
            <a href="#" onClick={out}>
              Log out
            </a>
            {(!orgless || slug !== "") && (
              <a className="btn btn-md" href={base + "/bots/new"}>
                New bot
              </a>
            )}
          </div>
        </div>
        {(!orgless || slug !== "") && (
          <nav className="dash-nav" aria-label="Main">
            {sections(base).map((s) => (
              <a key={s.label} href={s.href} className={!orgless && s.on(location.pathname) ? "on" : undefined}>
                {s.label}
              </a>
            ))}
          </nav>
        )}
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
