import { useEffect, useState, type FormEvent } from "react";
import { leaseText, type Inbox } from "./dashboard.js";
import { DashNav, Layout } from "./layout.js";
import * as lw from "./lw.js";

type Status = "active" | "ended" | "all";

export function Bot({ id }: { id: string }) {
  const me = lw.useMe();
  const ready = !!me;
  const botPath = "/bots/" + encodeURIComponent(id);
  const bot = lw.useGet<lw.Bot>(botPath, ready);
  const runners = lw.useList<lw.Runner>("/runners", ready);
  const inboxes = lw.useList<Inbox>("/inboxes", ready);
  const [status, setStatus] = useState<Status>("active");
  const threads = lw.useList<lw.Thread>(botPath + "/threads?status=" + status, ready);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runner = (rid: string | null) => runners.data?.find((r) => r.id === rid);
  const b = bot.data;

  async function remove() {
    if (!confirm(`Delete ${b?.name}? Its threads are deleted with it.`)) return;
    const r = await lw.api(botPath, { method: "DELETE" });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) return setError(await lw.message(r));
    location.assign("/dashboard");
  }

  async function release(t: lw.Thread) {
    const name = runner(t.runner_id)?.name ?? "its runner";
    if (!confirm(`Release this thread from ${name}? The next runner to claim it starts it fresh.`)) return;
    const r = await lw.api(`${botPath}/threads/${t.id}/release`, { method: "POST", body: {} });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) return setError(await lw.message(r));
    void threads.reload();
  }

  return (
    <Layout title="Bot · loopway" nav={<DashNav me={me} />}>
      <div className="page-head">
        <div>
          <h1>{bot.missing ? "Bot not found" : (b?.name ?? "Bot")}</h1>
          {b && (
            <div className="muted mono">
              {b.kind} · read up to #{b.cursor} · {leaseText(b, runner(b.runner_id)?.name)}
            </div>
          )}
          {b && (
            <div className="muted mono">
              {b.inbox_ids.map((i, n) => {
                const inbox = inboxes.data?.find((x) => x.id === i);
                return (
                  <span key={i}>
                    {n > 0 && ", "}
                    <a href={"/dashboard/inboxes/" + i}>{inbox?.name ?? i}</a>
                  </span>
                );
              })}
            </div>
          )}
        </div>
        {b && (
          <button className="btn btn-md" type="button" onClick={() => setEditing(!editing)}>
            Edit
          </button>
        )}
      </div>
      {b && editing && (
        <EditBot
          bot={b}
          inboxes={inboxes.data ?? []}
          onSaved={() => {
            setEditing(false);
            void bot.reload();
          }}
          onDelete={() => void remove()}
        />
      )}
      {error && <p className="error">{error}</p>}

      {b && <Instructions key={b.prompt_version?.version ?? 0} bot={b} onSaved={() => void bot.reload()} />}

      <div className="page-head section">
        <h1>Threads</h1>
        <div className="input-wrap">
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            <option value="active">Active</option>
            <option value="ended">Ended</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>
      <ul className="list">
        {threads.data?.map((t) => {
          const owner = runner(t.runner_id);
          return (
            <li key={t.id}>
              <a className="title" href={`/dashboard/bots/${id}/threads/${t.id}`}>
                {t.subjects.length ? t.subjects.join(", ") : t.id}
              </a>
              <Flags t={t} />
              <div className="meta">
                {t.status} · {t.runner_id ? `on ${owner?.name ?? "an unknown runner"}` : "no runner yet"} ·{" "}
                {t.waiting.length} waiting · {t.inflight.length} inflight · {t.delivered} delivered · updated{" "}
                {lw.when(t.updated_at)}
              </div>
              {t.runner_id && !owner?.leased_until && (
                <div className="actions">
                  <button className="btn btn-sm btn-quiet" type="button" onClick={() => void release(t)}>
                    Release
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {threads.data?.length === 0 && (
        <p className="muted" style={{ marginTop: 24 }}>
          No {status === "all" ? "" : status + " "}threads.
        </p>
      )}
    </Layout>
  );
}

const stringify = (rules: lw.BotRule[] | null) => JSON.stringify(rules ?? [], null, 2);

/**
 * The bot's current prompt and rules, with a form to save an edit as a new version, and the earlier versions. The
 * page remounts it (by key) when the bot has a new version, which resets the form and reloads the list.
 */
function Instructions({ bot, onSaved }: { bot: lw.Bot; onSaved: () => void }) {
  const current = bot.prompt_version;
  const versions = lw.useList<lw.BotVersion>("/bots/" + bot.id + "/versions", true);
  const [prompt, setPrompt] = useState(current?.prompt ?? "");
  const [rules, setRules] = useState(stringify(current?.rules ?? null));
  const [error, setError] = useState<string | null>(null);
  const changed = prompt !== (current?.prompt ?? "") || rules !== stringify(current?.rules ?? null);

  /** Saves a new version; rules that don't parse come back as an error, and nothing is saved. */
  async function save(body: { prompt: string; rules: lw.BotRule[] }) {
    setError(null);
    const r = await lw.api("/bots/" + bot.id + "/versions", { method: "POST", body });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) return setError(await lw.message(r));
    onSaved();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    let parsed: lw.BotRule[];
    try {
      parsed = JSON.parse(rules) as lw.BotRule[];
    } catch {
      return setError("The rules aren't valid JSON.");
    }
    await save({ prompt, rules: parsed });
  }

  async function restore(v: lw.BotVersion) {
    if (!confirm(`Save version ${v.version} again as the newest version?`)) return;
    await save({ prompt: v.prompt, rules: v.rules ?? [] });
  }

  return (
    <>
      <div className="page-head section">
        <h1>Instructions</h1>
        <div className="muted mono">{current ? `version ${current.version}` : "no version yet"}</div>
      </div>
      <form className="panel" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor="bot-prompt">Prompt</label>
          <div className="input-wrap tall">
            <textarea
              id="bot-prompt"
              required
              rows={14}
              maxLength={100000}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="bot-rules">Assign rules</label>
          <div className="input-wrap tall">
            <textarea
              id="bot-rules"
              rows={14}
              spellCheck={false}
              value={rules}
              onChange={(e) => setRules(e.target.value)}
            />
          </div>
          <p className="hint">
            JSON: a list of rules, each with <code>types</code> and CEL expressions <code>subject</code>,{" "}
            <code>related</code> and <code>action</code>. The first rule that matches a message&apos;s type applies.
          </p>
        </div>
        <div className="form-actions">
          <button className="btn" type="submit" disabled={!changed}>
            Save as a new version
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
      {!!versions.data?.length && (
        <>
          <div className="page-head section">
            <h1>Versions</h1>
          </div>
          <ul className="list">
            {versions.data.map((v) => (
              <li key={v.version}>
                <span className="title">Version {v.version}</span>
                {v.version === current?.version && <span className="badge">current</span>}
                <div className="meta">
                  saved {lw.when(v.created_at)} · {v.rules ? `${v.rules.length} rules` : "no rules"} · {v.prompt.length}{" "}
                  characters of prompt
                </div>
                {v.version !== current?.version && (
                  <div className="actions">
                    <button className="btn btn-sm btn-quiet" type="button" onClick={() => void restore(v)}>
                      Restore
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Flags({ t }: { t: lw.Thread }) {
  return (
    <>
      {t.interrupted && <span className="badge">interrupted</span>}
      {t.limited && <span className="badge">limited</span>}
    </>
  );
}

function EditBot({
  bot,
  inboxes,
  onSaved,
  onDelete,
}: {
  bot: lw.Bot;
  inboxes: Inbox[];
  onSaved: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(bot.name);
  const [checked, setChecked] = useState(new Set(bot.inbox_ids));
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
    const r = await lw.api("/bots/" + bot.id, { method: "PATCH", body: { name, inbox_ids: [...checked] } });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) return setError(await lw.message(r));
    onSaved();
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
        <label>Inboxes</label>
        <div className="checks">
          {inboxes.map((i) => (
            <label key={i.id} className="check">
              <input type="checkbox" checked={checked.has(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} />{" "}
              {i.name}
            </label>
          ))}
        </div>
      </div>
      <div className="form-actions">
        <button className="btn" type="submit">
          Save
        </button>
        <button className="btn btn-quiet" type="button" onClick={onDelete}>
          Delete bot
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

export function Thread({ botId, id }: { botId: string; id: string }) {
  const me = lw.useMe();
  const ready = !!me;
  const bot = lw.useGet<lw.Bot>("/bots/" + encodeURIComponent(botId), ready);
  const thread = lw.useGet<lw.Thread>(`/bots/${encodeURIComponent(botId)}/threads/${encodeURIComponent(id)}`, ready);
  const runners = lw.useList<lw.Runner>("/runners", ready);
  const t = thread.data;
  const owner = runners.data?.find((r) => r.id === t?.runner_id);

  return (
    <Layout
      title="Thread · loopway"
      nav={
        <DashNav me={me}>
          <a href={"/dashboard/bots/" + botId}>{bot.data?.name ?? "Bot"}</a>
        </DashNav>
      }
    >
      <div className="page-head">
        <div>
          <h1>{thread.missing ? "Thread not found" : (t?.subjects.length ? t.subjects : ["Thread"]).map(subject)}</h1>
          {t && (
            <div className="muted mono">
              {t.status}
              {t.started ? " · started" : ""} ·{" "}
              {t.runner_id ? `on ${owner?.name ?? "an unknown runner"}` : "no runner yet"}
              <Flags t={t} />
            </div>
          )}
        </div>
      </div>
      {t && (
        <>
          {t.runner_id && (
            <p className="hint">
              The transcript lives on {owner?.name ?? "the runner"} at <code>~/.loopway/threads/{t.id}.log</code>.
            </p>
          )}
          <Group title="Waiting" messages={t.waiting.map((m) => ({ ...m, key: m.subject, at: null }))} />
          <Group title="Inflight" messages={t.inflight.map((m) => ({ ...m, key: m.subject, at: null }))} />
          <Group
            title="Delivered"
            messages={(t.delivered_messages ?? []).map((m) => ({ ...m, subject: m.key, at: m.delivered_at }))}
          />
        </>
      )}
    </Layout>
  );
}

function subject(s: string, i: number) {
  const url = lw.subjectUrl(s);
  return (
    <span key={s}>
      {i > 0 && ", "}
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          {s}
        </a>
      ) : (
        s
      )}
    </span>
  );
}

interface Row {
  id: string;
  inbox_id: string;
  type: string;
  subject: string | null;
  at: string | null;
}

function Group({ title, messages }: { title: string; messages: Row[] }) {
  return (
    <>
      <div className="page-head section">
        <h1>
          {title} <span className="muted">{messages.length}</span>
        </h1>
      </div>
      {messages.map((m) => (
        <MessageRow key={m.id} m={m} />
      ))}
    </>
  );
}

// The thread only lists a message's id, so its JSON is fetched from its inbox when the row is opened.
function MessageRow({ m }: { m: Row }) {
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState<unknown>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || event) return;
    void lw.api(`/inboxes/${m.inbox_id}/messages/${m.id}`).then(async (r) => {
      if (!r.ok) return setFailed(true);
      setEvent(((await r.json()) as { event: unknown }).event);
    });
  }, [open, event, m.inbox_id, m.id]);

  return (
    <details className="message" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="type">{m.type}</span>
        <span className="muted">{m.subject || ""}</span>
        {m.at && <span className="when">{lw.when(m.at)}</span>}
      </summary>
      <pre>{failed ? "Couldn't load this message." : event ? JSON.stringify(event, null, 2) : "Loading…"}</pre>
    </details>
  );
}
