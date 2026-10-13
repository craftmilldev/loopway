import { useState, type FormEvent } from "react";
import { PRESETS } from "@loopway/presets";
import { useSourceRequest } from "../ee/client/source-request.js";
import { DashLayout } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

export interface Inbox {
  id: string;
  name: string;
  source_type: string;
  webhook_url: string;
  config?: { secret?: string | null };
}

/** `/dashboard/bots/new`: the create form, until the new-bot flow lands. */
export function NewBot() {
  const me = lw.useMe();
  const inboxes = lw.useList<Inbox>("/inboxes", !!me);
  return (
    <DashLayout title="New bot · loopway" me={me}>
      <div className="page-head">
        <h1>New bot</h1>
      </div>
      {inboxes.data && (
        <CreateBot inboxes={inboxes.data} onCreated={(id) => location.assign("/dashboard/bots/" + id)} />
      )}
    </DashLayout>
  );
}

/** `/dashboard/inboxes`: the inbox list and its create form, until the inboxes page lands. */
export function Inboxes() {
  const me = lw.useMe();
  const inboxes = lw.useList<Inbox>("/inboxes", !!me);
  const [creating, setCreating] = useState(false);
  return (
    <DashLayout title="Inboxes · loopway" me={me}>
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
    </DashLayout>
  );
}

/** Who holds the bot, in words. */
export function leaseText(b: lw.Bot, runner: string | undefined) {
  if (!b.leased_until) return "not running";
  return `running on ${runner ?? "a runner"} until ${lw.when(b.leased_until)}`;
}

function CreateBot({ inboxes, onCreated }: { inboxes: Inbox[]; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [preset, setPreset] = useState(Object.keys(PRESETS)[0]!);
  const [model, setModel] = useState(lw.BOT_MODELS[0]!);
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
    if (!checked.size) {
      track("bot_create_no_inbox");
      return setError("Pick at least one inbox.");
    }
    const { prompt, rules } = PRESETS[preset]!;
    const r = await lw.api("/bots", { method: "POST", body: { name, prompt, rules, model, inbox_ids: [...checked] } });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) {
      track("bot_create_rejected", { status: r.status });
      return setError(await lw.message(r));
    }
    onCreated(((await r.json()) as lw.Bot).id);
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
        <label htmlFor="bot-preset">Start from</label>
        <div className="input-wrap">
          <select id="bot-preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
            {Object.entries(PRESETS).map(([k, p]) => (
              <option key={k} value={k}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <p className="hint">{PRESETS[preset]!.description}</p>
      </div>
      <div className="field">
        <label htmlFor="bot-model">Model</label>
        <div className="input-wrap">
          <select id="bot-model" value={model} onChange={(e) => setModel(e.target.value)}>
            {lw.BOT_MODELS.map((m) => (
              <option key={m}>{m}</option>
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
