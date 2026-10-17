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
  config?: {
    secret?: string | null;
    events?: string[];
    schedule?: { every: "hour" } | { every: "day"; hour: number };
    messages?: { type: string; message: string }[];
  };
}

/** Who holds the bot, in words. */
export function leaseText(b: lw.Bot, runner: string | undefined) {
  if (!b.leased_until) return "not running";
  return `running on ${runner ?? "a runner"} until ${lw.when(b.leased_until)}`;
}

/** The Source option that asks for a new source type instead of creating an inbox. */
const REQUEST = "request:";

/** The inbox goes in the current org; the header's org switcher is the only way to change it. */
export function CreateInbox({ onCreated }: { onCreated: (inbox: Inbox) => void }) {
  const orgs = lw.useOrgs(true);
  const org = orgs ? lw.startOrg(orgs) : "";
  const {
    data: sources = [],
    can_request,
    schedule_options: scheduleOptions = ["hour", "day"],
  } = lw.useSources() ?? {};
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [all, setAll] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [secret, setSecret] = useState("");
  const [every, setEvery] = useState<"hour" | "day">("hour");
  const [hour, setHour] = useState(9);
  const [messages, setMessages] = useState<{ type: string; message: string }[]>([{ type: "", message: "" }]);
  const [error, setError] = useState<string | null>(null);
  const sourceRequest = useSourceRequest(setError);

  const requesting = type === REQUEST;
  // The first source is picked until the user picks another.
  const source = requesting ? undefined : (sources.find((s) => s.type === type) ?? sources[0]);

  // The chosen option, or the first this deploy offers when the chosen one is turned off.
  const chosenEvery = scheduleOptions.includes(every) ? every : (scheduleOptions[0] ?? every);

  const minLength = source?.secret.from === "loopway" ? source.secret.min_length : undefined;

  function toggle(event: string, on: boolean) {
    const next = new Set(checked);
    if (on) next.add(event);
    else next.delete(event);
    setChecked(next);
  }

  function editMessage(i: number, patch: Partial<{ type: string; message: string }>) {
    setMessages(messages.map((m, j) => (j === i ? { ...m, ...patch } : m)));
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
    if (!org) return setError("Choose an org.");
    // A schedule has no webhook: its config is a clock and the messages it sends.
    if (source.secret.from === "none") {
      const config = {
        schedule: chosenEvery === "hour" ? { every: chosenEvery } : { every: chosenEvery, hour },
        messages,
      };
      return create(config);
    }
    const events = all ? ["*"] : source.events.filter((ev) => checked.has(ev));
    if (!events.length) return setError("Pick at least one event.");
    // A sender-made secret is pasted in on the inbox page afterwards.
    const config = source.secret.from === "sender" ? { events } : { events, secret };
    return create(config);
  }

  async function create(config: unknown) {
    if (!source) return;
    const r = await lw.api("/inboxes", { method: "POST", body: { org, name, source_type: source.type, config } });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) {
      track("inbox_create_rejected", { status: r.status, source_type: source.type });
      return setError(await lw.message(r));
    }
    lw.rememberOrg(org);
    onCreated((await r.json()) as Inbox);
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
      ) : source?.secret.from === "none" ? (
        <>
          <div className="field">
            <label htmlFor="every">Runs</label>
            <div className="input-wrap">
              <select id="every" value={chosenEvery} onChange={(e) => setEvery(e.target.value as "hour" | "day")}>
                {scheduleOptions.includes("hour") && <option value="hour">Every hour</option>}
                {scheduleOptions.includes("day") && <option value="day">Every day</option>}
              </select>
              {chosenEvery === "day" && (
                <select aria-label="Hour (UTC)" value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      at {String(h).padStart(2, "0")}:00 UTC
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
          <div className="field">
            <label>Messages</label>
            {messages.map((m, i) => (
              <div className="input-wrap" key={i}>
                <input
                  aria-label="Message type"
                  placeholder="type, e.g. standup"
                  required
                  maxLength={64}
                  pattern="[a-z0-9][a-z0-9._\-]*"
                  value={m.type}
                  onChange={(e) => editMessage(i, { type: e.target.value })}
                />
                <input
                  aria-label="Message text"
                  placeholder="text sent with it"
                  required
                  maxLength={10000}
                  value={m.message}
                  onChange={(e) => editMessage(i, { message: e.target.value })}
                />
                {messages.length > 1 && (
                  <button
                    className="btn btn-sm btn-quiet"
                    type="button"
                    onClick={() => setMessages(messages.filter((_, j) => j !== i))}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            {messages.length < 20 && (
              <button
                className="btn btn-sm btn-quiet"
                type="button"
                onClick={() => setMessages([...messages, { type: "", message: "" }])}
              >
                Add a message
              </button>
            )}
            <p className="hint">
              Each run sends one message per type, with its text. A type is lowercase letters, digits, "." "_" or "-".
            </p>
          </div>
          <div className="form-actions">
            <button className="btn" type="submit">
              Create inbox
            </button>
          </div>
        </>
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
                  minLength={minLength}
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
                <button className="btn btn-sm btn-quiet" type="button" onClick={generate}>
                  Generate
                </button>
              </div>
              <p className="hint">
                At least {minLength} characters. You enter the same secret in the sender's webhook settings.
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
