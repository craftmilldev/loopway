import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Layout, UserNav } from "./layout.js";
import * as lw from "./lw.js";

export interface Inbox {
  id: string;
  name: string;
  source_type: string;
  webhook_url: string;
  config?: { secret?: string | null };
}

export function Dashboard() {
  const me = lw.useMe();
  const [inboxes, setInboxes] = useState<Inbox[] | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const r = await lw.api("/inboxes");
    if (!r.ok) return lw.expired(r);
    setInboxes(((await r.json()) as { data: Inbox[] }).data);
  }, []);

  useEffect(() => {
    if (me) void load();
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
            void load();
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
  const sources = lw.useSources() ?? [];
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [all, setAll] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The first source is picked until the user picks another.
  const source = sources.find((s) => s.type === type) ?? sources[0];

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
    if (!source) return;
    setError(null);
    const events = all ? ["*"] : source.events.filter((ev) => checked.has(ev));
    if (!events.length) return setError("Pick at least one event.");
    // A sender-made secret is pasted in on the inbox page afterwards; some sources have none.
    const config = source.secret.from === "loopway" ? { events, secret } : { events };
    const r = await lw.api("/inboxes", { method: "POST", body: { name, source_type: source.type, config } });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) return setError(await lw.message(r));
    onCreated();
  }

  return (
    <form className="panel" onSubmit={(e) => void submit(e)}>
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
            value={source?.type ?? ""}
            onChange={(e) => {
              setType(e.target.value);
              setChecked(new Set());
            }}
          >
            {sources.map((s) => (
              <option key={s.type} value={s.type}>
                {s.label}
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
          Which events the inbox keeps. Anything else the webhook sends is rejected and shows as a failed delivery in
          the sender.
        </p>
      </div>
      {source?.secret.from === "sender" ? (
        <div className="field">
          <label>Secret</label>
          <p className="hint">
            {source.label} shows the secret once you add the webhook there. Paste it in on the inbox page; until then
            deliveries are rejected.
          </p>
        </div>
      ) : source?.secret.from === "none" ? (
        <div className="field">
          <label>Secret</label>
          <p className="hint">None. The sender authenticates with its loopway API token instead.</p>
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
            At least {source?.secret.min_length} characters. You enter the same secret in the sender's webhook settings.
          </p>
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
