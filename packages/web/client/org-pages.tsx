import { useEffect, type ReactNode } from "react";
import { Layout, NoBotsContext, OrgsContext } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";
import { setupDone, useSetupProgress, ZeroState } from "./zero-state.js";

/** The page for a path nothing is at. An org the user isn't in gets this too, so it can't tell them the org exists. */
export function NotFound() {
  return (
    <Layout title="Not found · loopway" nav={<a href="/dashboard">Dashboard</a>}>
      <div className="narrow">
        <p className="eyebrow">404</p>
        <h1>Page not found</h1>
        <p className="muted" style={{ marginTop: 12 }}>
          There is nothing at this address, or it isn't yours to see.
        </p>
      </div>
    </Layout>
  );
}

/**
 * Wraps the pages of the org named in the path. It renders them only for a member, and remembers the org as the
 * last one used; for anyone else, member of nothing by that name or not, it renders the not-found page.
 */
export function OrgGate({ children }: { children: ReactNode }) {
  const orgs = lw.useOrgs(true);
  const slug = lw.orgSlug();
  const member = !!orgs?.some((o) => o.slug === slug);
  useEffect(() => {
    if (!orgs) return;
    if (member) lw.rememberOrg(slug);
    else track("org_page_not_found");
  }, [orgs, member, slug]);
  // How far the org's setup is; null until the first load settles, and false if it fails, so the pages show as usual.
  const setup = useSetupProgress(member);
  if (!orgs) return null;
  if (!member) return <NotFound />;
  // Until all three setup steps are done, the org's pages give way to the zero state. Members (to invite) and the
  // new-bot form stay. A failed request shows the pages as usual.
  if (setup === null) return null;
  const zero = !!setup && !setupDone(setup);
  const shown = !zero || /^\/[^/]+\/(members|bots\/new)$/.test(location.pathname);
  return (
    <OrgsContext.Provider value={orgs}>
      <NoBotsContext.Provider value={zero}>{shown ? children : <ZeroState progress={setup} />}</NoBotsContext.Provider>
    </OrgsContext.Provider>
  );
}

/** `/<org>/inboxes`, the page that folded into the bots page: sends old links and bookmarks there. */
export function InboxesRedirect() {
  useEffect(() => {
    track("inboxes_page_redirected");
    location.replace(lw.orgBase() + "/bots");
  }, []);
  return null;
}

/** The API path of the bot or inbox an old /dashboard page (`rest` is what follows /dashboard) is about, else null. */
function entityPath(rest: string) {
  const bot = rest.match(/^\/bots\/([^/]+)(?:\/|$)/);
  if (bot && bot[1] !== "new") return "/bots/" + bot[1];
  const inbox = rest.match(/^\/inboxes\/([^/]+)$/);
  return inbox ? "/inboxes/" + inbox[1] : null;
}

/**
 * The old /dashboard/... addresses. Each goes to the same page under the org that owns the bot or inbox it names, else
 * under the user's last-used org (their personal org if there is none). Sends a signed-out visitor to log in first.
 */
export function DashboardRedirect({ rest }: { rest: string }) {
  useEffect(() => {
    void (async () => {
      const r = await lw.api("/orgs").catch(() => null);
      if (!r) return;
      if (!r.ok) return lw.expired(r);
      const orgs = ((await r.json()) as { data: lw.Org[] }).data;
      let slug = lw.startOrg(orgs);
      let owner = false;
      const entity = entityPath(rest);
      if (entity) {
        const e = await lw.api(entity).catch(() => null);
        if (e?.ok) {
          const { org_id } = (await e.json()) as { org_id: string };
          const found = orgs.find((o) => o.id === org_id)?.slug;
          if (found) {
            slug = found;
            owner = true;
          }
        }
      }
      track("dashboard_redirected", { page: rest.split("/")[1] || "overview", owner });
      location.replace("/" + encodeURIComponent(slug) + rest + location.search + location.hash);
    })();
  }, [rest]);
  return null;
}
