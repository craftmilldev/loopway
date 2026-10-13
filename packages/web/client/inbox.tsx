import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import type { Inbox as InboxInfo } from "./dashboard.js";
import { DashLayout } from "./layout.js";
import * as lw from "./lw.js";

interface InboxMessage {
  id: string;
  received_at: string;
  seq: number;
  event: { type: string; subject?: string };
}

export function Inbox({ id }: { id: string }) {
  const me = lw.useMe();
  const [inbox, setInbox] = useState<InboxInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [messages, setMessages] = useState<InboxMessage[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  // The bots that read this inbox, and how far each has read.
  const readers = (lw.useList<lw.Bot>("/bots", !!me).data ?? []).filter((b) => b.inbox_ids.includes(id));
  const source = lw.useSources()?.data.find((s) => s.type === inbox?.source_type);

  useEffect(() => {
    if (!me) return;
    void (async () => {
      const r = await lw.api("/inboxes/" + encodeURIComponent(id));
      if (r.status === 404) return setMissing(true);
      if (!r.ok) return lw.expired(r);
      setInbox((await r.json()) as InboxInfo);
    })();
  }, [me, id]);

  // Newest first; `after` continues from a previous page.
  const load = useCallback(
    async (after: string | null) => {
      const q = new URLSearchParams({ order: "desc", limit: "50" });
      if (after) q.set("cursor", after);
      const r = await lw.api("/inboxes/" + encodeURIComponent(id) + "/messages?" + q.toString());
      if (!r.ok) return lw.expired(r);
      const body = (await r.json()) as { data: InboxMessage[]; next_cursor: string | null };
      setMessages((prev) => (after && prev ? [...prev, ...body.data] : body.data));
      setCursor(body.next_cursor);
    },
    [id],
  );

  useEffect(() => {
    if (inbox) void load(null);
  }, [inbox, load]);

  return (
    <DashLayout title="Inbox · loopway" me={me}>
      <div className="page-head">
        <div>
          <h1>{missing ? "Inbox not found" : (inbox?.name ?? "Inbox")}</h1>
          <div className="muted" style={{ fontFamily: "var(--font-type)", fontSize: ".75rem", wordBreak: "break-all" }}>
            {inbox && inbox.source_type + " · " + inbox.webhook_url}
          </div>
        </div>
      </div>
      {inbox && source?.secret.from === "sender" && <SenderSecret inbox={inbox} source={source} onSaved={setInbox} />}
      <div>
        {messages?.map((e, i) => (
          <Fragment key={e.id}>
            <ReadMarkers readers={readers} seq={e.seq} newer={messages[i - 1]?.seq} />
            <details className="message">
              <summary>
                <span className="muted">#{e.seq}</span>
                <span className="type">{e.event.type}</span>
                <span className="muted">{e.event.subject || ""}</span>
                <span className="when">{new Date(e.received_at).toLocaleString()}</span>
              </summary>
              <pre>{JSON.stringify(e.event, null, 2)}</pre>
            </details>
          </Fragment>
        ))}
      </div>
      {messages?.length === 0 && (
        <p className="muted" style={{ marginTop: 24 }}>
          No messages.
        </p>
      )}
      <div className="form-actions">
        {cursor && (
          <button className="btn btn-md btn-quiet" type="button" onClick={() => void load(cursor)}>
            Load older
          </button>
        )}
      </div>
    </DashLayout>
  );
}

// A divider above the message a bot has read up to: messages with seq <= its cursor are read, and the list is newest
// first, so it sits between `newer` (unread) and `seq` (read). A bot that has read everything shown sits at the top.
function ReadMarkers({ readers, seq, newer }: { readers: lw.Bot[]; seq: number; newer: number | undefined }) {
  const here = readers.filter((b) => b.cursor >= seq && (newer === undefined || b.cursor < newer));
  return (
    <>
      {here.map((b) => (
        <div key={b.id} className="read-marker">
          <a href={"/dashboard/bots/" + b.id}>{b.name}</a> has read up to here (#{b.cursor})
        </div>
      ))}
    </>
  );
}

// Some senders make the signing secret when the webhook is added there, so it's pasted in here afterwards.
function SenderSecret({
  inbox,
  source,
  onSaved,
}: {
  inbox: InboxInfo;
  source: lw.Source;
  onSaved: (inbox: InboxInfo) => void;
}) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isSet = !!inbox.config?.secret;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await lw.api("/inboxes/" + encodeURIComponent(inbox.id), {
      method: "PATCH",
      body: { config: { secret } },
    });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) return setError(await lw.message(r));
    setSecret("");
    onSaved({ ...inbox, ...((await r.json()) as InboxInfo) });
  }

  return (
    <form className="panel" onSubmit={(e) => void submit(e)}>
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
