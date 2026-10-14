import { useState, type FormEvent } from "react";
import { useSourceRequest } from "../ee/client/source-request.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

export interface Inbox {
  id: string;
  org_id: string;
  name: string;
  source_type: string;
  webhook_url: string;
  config?: { secret?: string | null; events?: string[] };
}

/** Who holds the bot, in words. */
export function leaseText(b: lw.Bot, runner: string | undefined) {
  if (!b.leased_until) return "not running";
  return `running on ${runner ?? "a runner"} until ${lw.when(b.leased_until)}`;
}

/** The Source option that asks for a new source type instead of creating an inbox. */
const REQUEST = "request:";

/** The org a new inbox or bot goes in. */
export function OrgSelect({
  orgs,
  value,
  onChange,
}: {
  orgs: lw.Org[];
  value: string;
  onChange: (slug: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor="org">Org</label>
      <div className="input-wrap">
        <select id="org" value={value} onChange={(e) => onChange(e.target.value)}>
          {orgs.map((o) => (
            <option key={o.id} value={o.slug}>
              {o.slug}
              {o.personal ? " (personal)" : ""}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** The org dropdown is shown unless the caller (the new-bot flow) already asked for the org and passes `org`. */
export function CreateInbox({ org: given, onCreated }: { org?: string; onCreated: (inbox: Inbox) => void }) {
  const orgs = lw.useOrgs(true);
  const [chosen, setChosen] = useState<string | null>(null);
  const org = given ?? chosen ?? (orgs ? lw.startOrg(orgs) : "");
  const { data: sources = [], can_request } = lw.useSources() ?? {};
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [all, setAll] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sourceRequest = useSourceRequest(setError);

  const requesting = type === REQUEST;
  // The first source is picked until the user picks another.
  const source = requesting ? undefined : (sources.find((s) => s.type === type) ?? sources[0]);

  function toggle(event: string, on: boolean) {
    const next = new Set(checked);
    if (on) next.add(event);
    else next.delete(event);
    setChecked(next);
  }

  function generate() {
    const b = crypto.getRandomValues(new Uint8Array(24));
    setSecret(Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (requesting) return sourceRequest.send();
    if (!source) return;
    const events = all ? ["*"] : source.events.filter((ev) => checked.has(ev));
    if (!events.length) return setError("Pick at least one event.");
    // A sender-made secret is pasted in on the inbox page afterwards.
    const config = source.secret.from === "sender" ? { events } : { events, secret };
    if (!org) return setError("Choose an org.");
    const r = await lw.api("/inboxes", { method: "POST", body: { org, name, source_type: source.type, config } });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) {
      track("inbox_create_rejected", { status: r.status });
      return setError(await lw.message(r));
    }
    lw.rememberOrg(org);
    onCreated((await r.json()) as Inbox);
  }

  return (
    <form className="panel" onSubmit={(e) => void submit(e)}>
      {!requesting && given === undefined && orgs && <OrgSelect orgs={orgs} value={org} onChange={setChosen} />}
      {!requesting && (
        <div className="field">
          <label htmlFor="name">Name</label>
          <div className="input-wrap">
            <input id="name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor="source">Source</label>
        <div className="input-wrap">
          <select
            id="source"
            required
            value={requesting ? REQUEST : (source?.type ?? "")}
            onChange={(e) => {
              setType(e.target.value);
              setChecked(new Set());
              setError(null);
            }}
          >
            {sources.map((s) => (
              <option key={s.type} value={s.type}>
                {s.label}
              </option>
            ))}
            {can_request && <option value={REQUEST}>Something else…</option>}
          </select>
        </div>
      </div>
      {requesting ? (
        sourceRequest.fields
      ) : (
        <>
          <div className="field">
            <label>Events</label>
            <div className="checks">
              <label className="check all">
                <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Everything
              </label>
              {source?.events.map((ev) => (
                <label key={ev} className="check">
                  <input
                    type="checkbox"
                    disabled={all}
                    checked={checked.has(ev)}
                    onChange={(e) => toggle(ev, e.target.checked)}
                  />{" "}
                  {ev}
                </label>
              ))}
            </div>
            <p className="hint">
              Which events the inbox keeps. Anything else the webhook sends is rejected and shows as a failed delivery
              in the sender.
            </p>
          </div>
          {source?.secret.from === "sender" ? (
            <div className="field">
              <label>Secret</label>
              <p className="hint">
                {source.label} shows the secret once you add the webhook there. Paste it in on the inbox page; until
                then deliveries are rejected.
              </p>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="secret">Secret</label>
              <div className="input-wrap">
                <input
                  id="secret"
                  required
                  minLength={source?.secret.min_length}
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
                <button className="btn btn-sm btn-quiet" type="button" onClick={generate}>
                  Generate
                </button>
              </div>
              <p className="hint">
                At least {source?.secret.min_length} characters. You enter the same secret in the sender's webhook
                settings.
              </p>
            </div>
          )}
          <div className="form-actions">
            <button className="btn" type="submit">
              Create inbox
            </button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
