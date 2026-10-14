import { useEffect, useState, type FormEvent } from "react";
import { DashLayout } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

interface Member {
  id: string;
  username: string | null;
  email: string | null;
}
interface Members {
  members: Member[];
  pending: string[];
}

const nameOf = (m: Member) => m.username || m.email || m.id;

/** `/<org>/members`: who is in the org and whose email is waiting for an account, with ways to add and remove. */
export function MembersPage() {
  const me = lw.useMe();
  const ready = !!me;
  const orgs = lw.useOrgs(ready);
  const slug = lw.orgSlug();
  const path = "/orgs/" + encodeURIComponent(slug) + "/members";
  const list = lw.useGet<Members>(path, ready);
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const org = orgs?.find((o) => o.slug === slug);
  const personal = !!org?.personal;
  const data = list.data;
  useEffect(() => {
    if (data && org) {
      track("members_viewed", { members: data.members.length, pending: data.pending.length, personal: org.personal });
    }
  }, [!!data, org?.personal]); // eslint-disable-line react-hooks/exhaustive-deps

  /** True when the request failed (the reason is shown, or an expired login has left the page). */
  async function failed(r: Response, action: string) {
    if (r.status === 401) {
      lw.expired(r);
      return true;
    }
    if (r.ok) return false;
    const code = (await lw.errorCode(r)) ?? "unknown";
    track("member_" + action + "_rejected", { status: r.status, code });
    setError(await lw.message(r));
    return true;
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const r = await lw.api(path, { method: "POST", body: { email } });
      if (await failed(r, "add")) return;
      const next = (await r.json()) as Members;
      const addr = email.trim().toLowerCase();
      const given = email.trim();
      const pending = next.pending.some((p) => p.toLowerCase() === addr);
      setNotice(
        r.status === 200
          ? `${given} is already ${pending ? "pending" : "a member"}.`
          : pending
            ? `${given} is pending until they sign up.`
            : `Added ${given}.`,
      );
      track("member_added", { result: r.status === 200 ? "already_there" : pending ? "pending" : "member" });
      setEmail("");
      void list.reload();
    } catch {
      track("member_add_failed", { reason: "network" });
      setError("Couldn't reach loopway. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: Member | string) {
    const pending = typeof m === "string";
    const self = !pending && m.id === me?.id;
    const who = pending ? m : nameOf(m);
    const ask = self ? `Leave ${slug}? You'll lose access to its bots and inboxes.` : `Remove ${who} from ${slug}?`;
    if (!confirm(ask)) return track("member_remove_cancelled", { self, pending });
    setError(null);
    setNotice(null);
    try {
      const r = await lw.api(
        pending ? path + "/pending?email=" + encodeURIComponent(m) : path + "/" + encodeURIComponent(m.id),
        { method: "DELETE" },
      );
      if (await failed(r, "remove")) return;
      track("member_removed", { self, pending });
      if (self) {
        const home = orgs?.find((o) => o.personal)?.slug;
        if (home) lw.rememberOrg(home);
        location.assign(home ? "/" + encodeURIComponent(home) : "/dashboard");
        return;
      }
      setNotice(`Removed ${who}.`);
      void list.reload();
    } catch {
      track("member_remove_failed", { reason: "network" });
      setError("Couldn't reach loopway. Try again.");
    }
  }

  return (
    <DashLayout title="Members · loopway" me={me}>
      <section className="ov-top">
        <div>
          <span className="lbl">Members</span>
          <h1 className="ov-headline">Who is in {slug}</h1>
          <p className="muted">
            {personal
              ? "Personal orgs can't have other members."
              : "Everyone in the org can see and change its bots, inboxes and runners."}
          </p>
        </div>
      </section>

      {org && !personal && (
        <form className="panel" onSubmit={(e) => void add(e)}>
          <div className="field">
            <label htmlFor="member-email">Add by email</label>
            <div className="input-wrap">
              <input
                id="member-email"
                type="email"
                required
                maxLength={320}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <p className="hint">If they have no account yet, they join as soon as they sign up with this email.</p>
          </div>
          <div className="form-actions">
            <button className="btn btn-md" type="submit" disabled={busy}>
              Add member
            </button>
          </div>
        </form>
      )}

      <div aria-live="polite">
        {notice && <p className="muted">{notice}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>

      {data && (
        <div className="scroll">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Email</th>
                <th scope="col" className="num">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={m.id}>
                  <td>{nameOf(m)}</td>
                  <td className="mono">{m.email ?? "—"}</td>
                  <td className="num">
                    {!personal && (
                      <button
                        className="btn btn-sm btn-quiet"
                        type="button"
                        aria-label={`${m.id === me?.id ? "Leave org" : "Remove"} ${nameOf(m)}`}
                        onClick={() => void remove(m)}
                      >
                        {m.id === me?.id ? "Leave org" : "Remove"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {data.pending.map((p) => (
                <tr key={"pending:" + p}>
                  <td className="muted">pending</td>
                  <td className="mono">{p}</td>
                  <td className="num">
                    <button
                      className="btn btn-sm btn-quiet"
                      type="button"
                      aria-label={"Remove " + p}
                      onClick={() => void remove(p)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashLayout>
  );
}
