import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Inbox as InboxInfo } from "./shared.js";
import { DashLayout } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

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
  const bots = lw.useList<lw.Bot>(lw.inOrg("/bots"), !!me);
  const readers = (bots.data ?? []).filter((b) => b.inbox_ids.includes(id));
  // The list as last set, for the requests that finish after a render they started in.
  const listed = useRef<InboxMessage[] | null>(null);
  const source = lw.useSources()?.data.find((s) => s.type === inbox?.source_type);

  useEffect(() => {
    if (!me) return;
    void (async () => {
      const r = await lw.api("/inboxes/" + encodeURIComponent(id));
      if (r.status === 404) return setMissing(true);
      if (!r.ok) {
        track("inbox_load_failed", { status: r.status });
        return lw.expired(r);
      }
      setInbox((await r.json()) as InboxInfo);
    })();
  }, [me, id]);

  // Newest first; `after` continues from a previous page.
  const load = useCallback(
    async (after: string | null) => {
      const q = new URLSearchParams({ order: "desc", limit: "50" });
      if (after) q.set("cursor", after);
      const r = await lw.api("/inboxes/" + encodeURIComponent(id) + "/messages?" + q.toString());
      if (!r.ok) {
        track("inbox_messages_load_failed", { status: r.status });
        return lw.expired(r);
      }
      const body = (await r.json()) as { data: InboxMessage[]; next_cursor: string | null };
      listed.current = after && listed.current ? [...listed.current, ...body.data] : body.data;
      setMessages(listed.current);
      setCursor(body.next_cursor);
    },
    [id],
  );

  useEffect(() => {
    if (inbox) void load(null);
  }, [inbox, load]);

  // New messages and how far each reader has read. A refresh adds only the messages it hasn't got to the front, so
  // the open ones and "Load older" stay as they are. The inbox itself is what Setup and Settings edit: it loads once.
  lw.usePoll(bots.reload, !!me);
  lw.usePoll(async () => {
    const q = new URLSearchParams({ order: "desc", limit: "50" });
    const r = await lw.api("/inboxes/" + encodeURIComponent(id) + "/messages?" + q.toString());
    if (!r.ok) {
      track("inbox_messages_load_failed", { status: r.status });
      return false;
    }
    const body = (await r.json()) as { data: InboxMessage[]; next_cursor: string | null };
    // Merges into the list as it is now, not as it was when this request started: a page may have loaded since.
    const merged = lw.mergeNewest(listed.current, body.data, !!body.next_cursor);
    if (merged.items !== listed.current) {
      listed.current = merged.items;
      setMessages(merged.items);
    }
    if (merged.replaced) setCursor(body.next_cursor);
    return true;
  }, !!inbox);

  // A source that makes the secret on its side leaves the inbox rejecting deliveries until it's pasted in.
  const unfinished = !!inbox && !!source && source.secret.from !== "none" && !inbox.config?.secret_set;
  const loaded = !!inbox;
  useEffect(() => {
    if (loaded) track("inbox_viewed", { setup_unfinished: unfinished });
  }, [loaded, unfinished]);
  useEffect(() => {
    if (missing) track("inbox_not_found");
  }, [missing]);

  return (
    <DashLayout title="Inbox · loopway" me={me}>
      <div className="page-head">
        <div>
          <span className="lbl">{inbox && (source?.label ?? inbox.source_type)}</span>
          <h1>{missing ? "Inbox not found" : (inbox?.name ?? "Inbox")}</h1>
        </div>
        {unfinished && <span className="state state-limited">rejecting deliveries</span>}
      </div>
      {inbox && source?.secret.from !== "none" && (
        <Setup inbox={inbox} source={source} unfinished={unfinished} onSaved={setInbox} />
      )}
      {inbox && <Settings inbox={inbox} onSaved={setInbox} />}
      {inbox && <h2 className="inbox-recent">Recent messages</h2>}
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
          <a href={lw.orgBase() + "/bots/" + b.id}>{b.name}</a> has read up to here (#{b.cursor})
        </div>
      ))}
    </>
  );
}

/** PATCHes the inbox and returns it merged with the reply, or the API's message. `what` names the part for metrics. */
async function patch(inbox: InboxInfo, what: string, body: object): Promise<InboxInfo | string> {
  const r = await lw.api("/inboxes/" + encodeURIComponent(inbox.id), { method: "PATCH", body });
  if (r.status === 401) {
    lw.expired(r);
    return "Signed out.";
  }
  if (!r.ok) {
    track("inbox_save_failed", { what, status: r.status });
    return await lw.message(r);
  }
  track("inbox_saved", { what });
  return { ...inbox, ...((await r.json()) as InboxInfo) };
}

/** The webhook URL, the secret and the events: numbered steps while the inbox can't accept deliveries yet. */
function Setup({
  inbox,
  source,
  unfinished,
  onSaved,
}: {
  inbox: InboxInfo;
  source: lw.Source | undefined;
  unfinished: boolean;
  onSaved: (inbox: InboxInfo) => void;
}) {
  const steps: ReactNode[] = [
    <UrlField key="url" inbox={inbox} hint={unfinished && source ? `Add it in ${source.webhook_settings}.` : null} />,
  ];
  if (source?.secret.from === "sender") {
    steps.push(<SenderSecret key="secret" inbox={inbox} source={source} onSaved={onSaved} />);
  }
  steps.push(<EventToggles key="events" inbox={inbox} source={source} onSaved={onSaved} />);
  if (!unfinished) {
    return (
      <section className="panel setup">
        {steps.map((step, i) => (
          <div key={i}>{step}</div>
        ))}
      </section>
    );
  }
  return (
    <section className="panel setup">
      <h2>Finish setting up this inbox</h2>
      <ol className="steps">
        {steps.map((step, i) => (
          <li key={i}>
            <span className="step-n">{i + 1}</span>
            <div>{step}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function UrlField({ inbox, hint }: { inbox: InboxInfo; hint: string | null }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(inbox.webhook_url);
    } catch {
      return track("inbox_url_copy_failed");
    }
    track("inbox_url_copied");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className="field">
      <label htmlFor="hook">Webhook URL</label>
      <div className="input-wrap">
        <input id="hook" readOnly value={inbox.webhook_url} onFocus={(e) => e.currentTarget.select()} />
        <button className="btn btn-sm btn-quiet" type="button" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {hint && <p className="hint">{hint}</p>}
    </div>
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
  const isSet = !!inbox.config?.secret_set;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const saved = await patch(inbox, "secret", { config: { secret } });
    if (typeof saved === "string") return setError(saved);
    setSecret("");
    onSaved(saved);
  }

  return (
    <form className="field" onSubmit={(e) => void submit(e)}>
      <label htmlFor="secret">Signing secret</label>
      <div className="input-wrap">
        <input
          id="secret"
          required
          autoComplete="off"
          placeholder={isSet ? "set (paste a new one to replace it)" : "Paste the secret here"}
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
          : `${source.label} shows the secret once you save the webhook there. Until it's saved here, deliveries are rejected.`}
      </p>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

/** The events the inbox keeps: the source's, plus any already set that it no longer lists. */
function EventToggles({
  inbox,
  source,
  onSaved,
}: {
  inbox: InboxInfo;
  source: lw.Source | undefined;
  onSaved: (inbox: InboxInfo) => void;
}) {
  const current = inbox.config?.events ?? ["*"];
  const [all, setAll] = useState(current.includes("*"));
  const [checked, setChecked] = useState(new Set(current.filter((e) => e !== "*")));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const known = [...new Set([...(source?.events ?? []), ...current.filter((e) => e !== "*")])];

  function toggle(event: string, on: boolean) {
    const next = new Set(checked);
    if (on) next.add(event);
    else next.delete(event);
    setChecked(next);
    setSaved(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const events = all ? ["*"] : known.filter((ev) => checked.has(ev));
    if (!events.length) {
      track("inbox_events_none");
      return setError("Pick at least one event.");
    }
    const result = await patch(inbox, "events", { config: { events } });
    if (typeof result === "string") return setError(result);
    setSaved(true);
    onSaved(result);
  }

  return (
    <form className="field" onSubmit={(e) => void submit(e)}>
      <label>Events it keeps</label>
      <div className="checks">
        <label className="check all">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => {
              setAll(e.target.checked);
              setSaved(false);
            }}
          />{" "}
          Everything
        </label>
        {known.map((ev) => (
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
      <p className="hint">Anything else the webhook sends is rejected and shows as a failed delivery in the sender.</p>
      <div className="form-actions">
        <button className="btn btn-sm" type="submit">
          Save events
        </button>
        {saved && <span className="muted">Saved.</span>}
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Settings({ inbox, onSaved }: { inbox: InboxInfo; onSaved: (inbox: InboxInfo) => void }) {
  const [name, setName] = useState(inbox.name);
  const [error, setError] = useState<string | null>(null);

  async function rename(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const saved = await patch(inbox, "name", { name });
    if (typeof saved === "string") return setError(saved);
    onSaved(saved);
  }

  async function remove() {
    if (!confirm(`Delete ${inbox.name}? Its messages are deleted with it.`)) return track("inbox_delete_cancelled");
    const r = await lw.api("/inboxes/" + encodeURIComponent(inbox.id), { method: "DELETE" });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) {
      track("inbox_delete_failed", { status: r.status });
      return setError(await lw.message(r));
    }
    track("inbox_deleted");
    location.assign(lw.orgBase() + "/inboxes");
  }

  return (
    <section className="panel setup">
      <form className="field" onSubmit={(e) => void rename(e)}>
        <label htmlFor="inbox-name">Name</label>
        <div className="input-wrap">
          <input id="inbox-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-sm" type="submit">
            Rename
          </button>
        </div>
      </form>
      <div className="form-actions">
        <button className="btn btn-quiet" type="button" onClick={() => void remove()}>
          Delete inbox
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
