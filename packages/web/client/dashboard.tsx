import { useEffect, useState, type FormEvent } from "react";
import { useSourceRequest } from "../ee/client/source-request.js";
import { DashNav, Layout } from "./layout.js";
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
  const ready = !!me;
  const bots = lw.useList<lw.Bot>("/bots", ready);
  const runners = lw.useList<lw.Runner>("/runners", ready);
  const inboxes = lw.useList<Inbox>("/inboxes", ready);
  const [creatingInbox, setCreatingInbox] = useState(false);
  const [creatingBot, setCreatingBot] = useState(false);
  const [active, setActive] = useState<Record<string, number>>({});

  // Each bot's active threads, for the count. One request per bot.
  useEffect(() => {
    for (const b of bots.data ?? []) {
      void lw.api(`/bots/${b.id}/threads?status=active`).then(async (r) => {
        if (!r.ok) return;
        const count = ((await r.json()) as { data: unknown[] }).data.length;
        setActive((a) => ({ ...a, [b.id]: count }));
      });
    }
  }, [bots.data]);

  const runnerName = (id: string | null) => runners.data?.find((r) => r.id === id)?.name;

  return (
    <Layout title="Dashboard · loopway" nav={<DashNav me={me} />}>
      <div className="page-head" id="bots">
        <h1>Bots</h1>
        <button className="btn btn-md" type="button" onClick={() => setCreatingBot(!creatingBot)}>
          New bot
        </button>
      </div>
      {creatingBot && (
        <CreateBot
          inboxes={inboxes.data ?? []}
          onCreated={() => {
            setCreatingBot(false);
            void bots.reload();
          }}
        />
      )}
      <ul className="list">
        {bots.data?.map((b) => (
          <li key={b.id}>
            <a className="title" href={"/dashboard/bots/" + b.id}>
              {b.name}
            </a>
            <div className="meta">
              {b.kind} · {b.inbox_ids.map((i) => inboxes.data?.find((x) => x.id === i)?.name ?? i).join(", ")} ·{" "}
              {active[b.id] ?? "…"} active threads
            </div>
            <div className="meta">{leaseText(b, runnerName(b.runner_id))}</div>
          </li>
        ))}
      </ul>
      {bots.data?.length === 0 && (
        <p className="muted" style={{ marginTop: 24 }}>
          No bots yet.
        </p>
      )}

      <div className="page-head section" id="runners">
        <h1>Runners</h1>
      </div>
      <ul className="list">
        {runners.data?.map((r) => (
          <li key={r.id}>
            <span className="title">{r.name}</span>
            <div className="meta">
              {r.leased_until ? "online" : "offline"} · last seen {lw.when(r.last_seen_at)} · {r.bots.length} bots held
              · {r.threads} threads owned
            </div>
          </li>
        ))}
      </ul>
      {runners.data?.length === 0 && (
        <p className="muted" style={{ marginTop: 24 }}>
          No runners yet. Run <code>loopway bots run</code> on a machine.
        </p>
      )}

      <div className="page-head section" id="inboxes">
        <h1>Inboxes</h1>
        <button className="btn btn-md" type="button" onClick={() => setCreatingInbox(!creatingInbox)}>
          New inbox
        </button>
      </div>
      {creatingInbox && (
        <CreateInbox
          onCreated={() => {
            setCreatingInbox(false);
            void inboxes.reload();
          }}
        />
      )}
      <ul className="list">
        {inboxes.data?.map((i) => (
          <li key={i.id}>
            <a className="title" href={"/dashboard/inboxes/" + i.id}>
              {i.name}
            </a>
            <div className="meta">
              {i.source_type} · {i.webhook_url}
            </div>
          </li>
        ))}
      </ul>
      {inboxes.data?.length === 0 && (
        <p className="muted" style={{ marginTop: 24 }}>
          No inboxes yet.
        </p>
      )}
    </Layout>
  );
}

/** Who holds the bot, in words. */
export function leaseText(b: lw.Bot, runner: string | undefined) {
  if (!b.leased_until) return "not running";
  return `running on ${runner ?? "a runner"} until ${lw.when(b.leased_until)}`;
}

function CreateBot({ inboxes, onCreated }: { inboxes: Inbox[]; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState(lw.BOT_KINDS[0]!);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string, on: boolean) {
    const next = new Set(checked);
    if (on) next.add(id);
    else next.delete(id);
    setChecked(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!checked.size) return setError("Pick at least one inbox.");
    const r = await lw.api("/bots", { method: "POST", body: { name, kind, inbox_ids: [...checked] } });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) return setError(await lw.message(r));
    onCreated();
  }

  return (
    <form className="panel" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label htmlFor="bot-name">Name</label>
        <div className="input-wrap">
          <input id="bot-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="bot-kind">Kind</label>
        <div className="input-wrap">
          <select id="bot-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {lw.BOT_KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Inboxes</label>
        <div className="checks">
          {inboxes.map((i) => (
            <label key={i.id} className="check">
              <input type="checkbox" checked={checked.has(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} />{" "}
              {i.name}
            </label>
          ))}
        </div>
        <p className="hint">The bot reads the messages of every inbox it has.</p>
      </div>
      <div className="form-actions">
        <button className="btn" type="submit">
          Create bot
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

/** The Source option that asks for a new source type instead of creating an inbox. */
const REQUEST = "request:";

function CreateInbox({ onCreated }: { onCreated: () => void }) {
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
    const r = await lw.api("/inboxes", { method: "POST", body: { name, source_type: source.type, config } });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) return setError(await lw.message(r));
    onCreated();
  }

  return (
    <form className="panel" onSubmit={(e) => void submit(e)}>
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
