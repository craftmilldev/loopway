import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Layout, UserNav } from "./layout.js";
import * as lw from "./lw.js";

export interface Inbox {
  id: string;
  name: string;
  source_type: string;
  webhook_url: string;
}

// The GitHub events offered as checkboxes (same list as `loopway inbox create`).
const GITHUB_EVENTS = [
  "push",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issues",
  "issue_comment",
  "release",
  "workflow_run",
  "workflow_job",
  "check_run",
  "check_suite",
  "create",
  "delete",
  "deployment_status",
  "discussion",
  "star",
  "fork",
];

const EVENTS: Record<string, string[]> = {
  github: GITHUB_EVENTS,
  granola: ["note.generated", "note.edited", "note.access_granted"],
};

export function Dashboard() {
  const me = lw.useMe();
  const [inboxes, setInboxes] = useState<Inbox[] | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const r = await lw.api("/inboxes");
    if (!r.ok) return lw.expired(r);
    setInboxes((await r.json()).data);
  }, []);

  useEffect(() => {
    if (me) load();
  }, [me, load]);

  return (
    <Layout title="Inboxes · loopway" nav={<UserNav me={me} />}>
      <div className="page-head">
        <h1>Inboxes</h1>
        <button className="btn btn-md" type="button" onClick={() => setCreating(!creating)}>
          New inbox
        </button>
      </div>
      {creating && (
        <CreateInbox
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}
      <ul className="list">
        {inboxes?.map((i) => (
          <li key={i.id}>
            <a className="title" href={"/dashboard/" + i.id}>
              {i.name}
            </a>
            <div className="meta">
              {i.source_type} · {i.webhook_url}
            </div>
          </li>
        ))}
      </ul>
      {inboxes?.length === 0 && (
        <p className="muted" style={{ marginTop: 24 }}>
          No inboxes yet.
        </p>
      )}
    </Layout>
  );
}

function CreateInbox({ onCreated }: { onCreated: () => void }) {
  const [sources, setSources] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [all, setAll] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sourceEvents = EVENTS[source] ?? [];
  // Granola generates the secret itself once it has the webhook URL, so it's set after the inbox exists.
  const granola = source === "granola";

  useEffect(() => {
    lw.api("/sources").then(async (r) => {
      if (!r.ok) return;
      const types = ((await r.json()).data as { type: string }[]).map((s) => s.type);
      setSources(types);
      setSource((s) => s || types[0] || "");
    });
  }, []);

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
    const events = all ? ["*"] : sourceEvents.filter((ev) => checked.has(ev));
    if (!events.length) return setError("Pick at least one event.");
    const config = granola ? { events } : { events, secret };
    const r = await lw.api("/inboxes", { method: "POST", body: { name, source_type: source, config } });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) return setError(await lw.message(r));
    onCreated();
  }

  return (
    <form className="panel" onSubmit={submit}>
      <div className="field">
        <label htmlFor="name">Name</label>
        <div className="input-wrap">
          <input id="name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="source">Source</label>
        <div className="input-wrap">
          <select
            id="source"
            required
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setChecked(new Set());
            }}
          >
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Events</label>
        <div className="checks">
          <label className="check all">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Everything
          </label>
          {sourceEvents.map((ev) => (
            <label key={ev} className="check">
              <input type="checkbox" disabled={all} checked={checked.has(ev)} onChange={(e) => toggle(ev, e.target.checked)} /> {ev}
            </label>
          ))}
        </div>
        <p className="hint">Which events the inbox keeps. Anything else the webhook sends is rejected and shows as a failed delivery in the sender.</p>
      </div>
      {granola ? (
        <p className="hint">
          Granola makes the webhook secret. Once the inbox exists, add its webhook URL in Granola → Settings → Connectors → Webhooks, then set
          the whsec_… secret Granola shows with <code>loopway inbox update &lt;inbox&gt; --secret whsec_…</code>.
        </p>
      ) : (
        <div className="field">
          <label htmlFor="secret">Secret</label>
          <div className="input-wrap">
            <input id="secret" required minLength={16} autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
            <button className="btn btn-sm btn-quiet" type="button" onClick={generate}>
              Generate
            </button>
          </div>
          <p className="hint">At least 16 characters. You enter the same secret in the sender's webhook settings.</p>
        </div>
      )}
      <div className="form-actions">
        <button className="btn" type="submit">
          Create inbox
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
