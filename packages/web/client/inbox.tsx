import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Inbox as InboxInfo } from "./dashboard.js";
import { Layout, UserNav } from "./layout.js";
import * as lw from "./lw.js";

interface InboxEvent {
  id: string;
  status: string;
  received_at: string;
  event: { type: string; subject?: string };
}

export function Inbox({ id }: { id: string }) {
  const me = lw.useMe();
  const [inbox, setInbox] = useState<InboxInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [hide, setHide] = useState(false);
  const [events, setEvents] = useState<InboxEvent[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const source = lw.useSources()?.find((s) => s.type === inbox?.source_type);

  useEffect(() => {
    if (!me) return;
    (async () => {
      const r = await lw.api("/inboxes/" + encodeURIComponent(id));
      if (r.status === 404) return setMissing(true);
      if (!r.ok) return lw.expired(r);
      setInbox(await r.json());
    })();
  }, [me, id]);

  // Newest first; `after` continues from a previous page.
  const load = useCallback(
    async (after: string | null) => {
      const q = new URLSearchParams({ order: "desc", limit: "50", status: hide ? "unprocessed" : "all" });
      if (after) q.set("cursor", after);
      const r = await lw.api("/inboxes/" + encodeURIComponent(id) + "/events?" + q);
      if (!r.ok) return lw.expired(r);
      const body = await r.json();
      setEvents((prev) => (after && prev ? [...prev, ...body.data] : body.data));
      setCursor(body.next_cursor);
    },
    [id, hide],
  );

  useEffect(() => {
    if (inbox) load(null);
  }, [inbox, load]);

  return (
    <Layout
      title="Inbox · loopway"
      nav={
        <UserNav me={me}>
          <a href="/dashboard">Inboxes</a>
        </UserNav>
      }
    >
      <div className="page-head">
        <div>
          <h1>{missing ? "Inbox not found" : (inbox?.name ?? "Inbox")}</h1>
          <div className="muted" style={{ fontFamily: "var(--font-type)", fontSize: ".75rem", wordBreak: "break-all" }}>
            {inbox && inbox.source_type + " · " + inbox.webhook_url}
          </div>
        </div>
      </div>
      {inbox && source?.secret.from === "sender" && <SenderSecret inbox={inbox} source={source} onSaved={setInbox} />}
      <div className="toolbar">
        <label>
          <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} /> Hide processed
        </label>
      </div>
      <div>
        {events?.map((e) => (
          <details key={e.id} className="event">
            <summary>
              <span className="type">{e.event.type}</span>
              <span className="muted">{e.event.subject || ""}</span>
              <span className={"badge" + (e.status === "processed" ? " done" : "")}>{e.status}</span>
              <span className="when">{new Date(e.received_at).toLocaleString()}</span>
            </summary>
            <pre>{JSON.stringify(e.event, null, 2)}</pre>
          </details>
        ))}
      </div>
      {events?.length === 0 && (
        <p className="muted" style={{ marginTop: 24 }}>
          No events.
        </p>
      )}
      <div className="form-actions">
        {cursor && (
          <button className="btn btn-md btn-quiet" type="button" onClick={() => load(cursor)}>
            Load older
          </button>
        )}
      </div>
    </Layout>
  );
}

// Some senders make the signing secret when the webhook is added there, so it's pasted in here afterwards.
function SenderSecret({ inbox, source, onSaved }: { inbox: InboxInfo; source: lw.Source; onSaved: (inbox: InboxInfo) => void }) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isSet = !!inbox.config?.secret;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await lw.api("/inboxes/" + encodeURIComponent(inbox.id), { method: "PATCH", body: { config: { secret } } });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) return setError(await lw.message(r));
    setSecret("");
    onSaved({ ...inbox, ...(await r.json()) });
  }

  return (
    <form className="panel" onSubmit={submit}>
      <div className="field">
        <label htmlFor="secret">Webhook secret</label>
        <div className="input-wrap">
          <input
            id="secret"
            required
            autoComplete="off"
            placeholder={isSet ? "set (paste a new one to replace it)" : ""}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <button className="btn btn-sm" type="submit">
            Save
          </button>
        </div>
        <p className="hint">
          {isSet
            ? "Deliveries are checked against this secret."
            : `Not set yet. Add the webhook in ${source.webhook_settings} with the URL above, then paste the secret ${source.label} shows. Until then deliveries are rejected.`}
        </p>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
