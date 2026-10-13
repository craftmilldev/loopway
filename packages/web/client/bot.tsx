import { useEffect, useState, type FormEvent } from "react";
import { leaseText, type Inbox } from "./dashboard.js";
import { DashLayout } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

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
    <DashLayout title="Bot · loopway" me={me}>
      <div className="page-head">
        <div>
          <h1>{bot.missing ? "Bot not found" : (b?.name ?? "Bot")}</h1>
          {b && (
            <div className="muted mono">
              read up to #{b.cursor} · {leaseText(b, runner(b.runner_id)?.name)}
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

      {b && <Versions botPath={botPath} current={b.prompt_version} onSaved={() => void bot.reload()} />}

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
    </DashLayout>
  );
}

/** A rule as the form edits it: every field is text, and the type globs are one per line. */
interface RuleDraft {
  types: string;
  subject: string;
  related: string;
  action: string;
}

const EXPRESSIONS = [
  { key: "subject", label: "Subject", hint: 'CEL: the message\'s own subject, "" for none.' },
  { key: "related", label: "Related", hint: "CEL: a list of other subjects the message names." },
  { key: "action", label: "Action", hint: "CEL: 'attach' (the default) or 'skip'." },
] as const;

const toDrafts = (rules: lw.BotRule[] | null): RuleDraft[] =>
  (rules ?? []).map((r) => ({
    types: r.types.join("\n"),
    subject: r.subject ?? "",
    related: r.related ?? "",
    action: r.action ?? "",
  }));

const fromDrafts = (drafts: RuleDraft[]): lw.BotRule[] =>
  drafts.map((d) => {
    const rule: lw.BotRule = {
      types: d.types
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean),
    };
    for (const { key } of EXPRESSIONS) if (d[key].trim()) rule[key] = d[key].trim();
    return rule;
  });

/** A rule's fields as plain lines, for reading an old version. */
function RuleSummary({ rule }: { rule: lw.BotRule }) {
  return (
    <pre>
      {[
        "types: " + rule.types.join(", "),
        ...EXPRESSIONS.filter(({ key }) => rule[key]).map(({ key }) => `${key}: ${rule[key]}`),
      ].join("\n")}
    </pre>
  );
}

/** The bot's current prompt and rules with a form to edit them, and its earlier versions to restore. */
function Versions({
  botPath,
  current,
  onSaved,
}: {
  botPath: string;
  current: lw.BotVersion | null;
  onSaved: () => void;
}) {
  const history = lw.useList<lw.BotVersion>(botPath + "/versions", true);
  const [prompt, setPrompt] = useState(current?.prompt ?? "");
  const [rules, setRules] = useState(toDrafts(current?.rules ?? null));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const version = current?.version;

  // A new current version (saved here, or by the CLI) fills the form.
  useEffect(() => {
    setPrompt(current?.prompt ?? "");
    setRules(toDrafts(current?.rules ?? null));
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const setRule = (i: number, patch: Partial<RuleDraft>) =>
    setRules(rules.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  async function save(body: { prompt: string; rules?: lw.BotRule[] }, restored?: number) {
    setError(null);
    setSaved(null);
    const r = await lw.api(botPath + "/versions", { method: "POST", body });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) return setError(await lw.message(r));
    const v = (await r.json()) as lw.BotVersion;
    if (restored) track("bot_version_restored");
    setSaved(v.version);
    onSaved();
    void history.reload();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = fromDrafts(rules);
    if (!parsed.length) {
      track("bot_rules_missing");
      return setError("Add at least one rule.");
    }
    const empty = parsed.findIndex((r) => !r.types.length);
    if (empty >= 0) {
      track("bot_rule_missing_types");
      return setError(`Rule ${empty + 1} needs at least one event type.`);
    }
    void save({ prompt, rules: parsed });
  }

  return (
    <>
      <div className="page-head section">
        <h1>Prompt and rules</h1>
        {current && <span className="muted mono">version {current.version}</span>}
      </div>
      <form className="panel" onSubmit={submit}>
        <div className="field">
          <label htmlFor="bot-prompt">Prompt</label>
          <textarea
            id="bot-prompt"
            required
            maxLength={100_000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Rules</label>
          <p className="hint">
            The first rule whose event types match a message applies. The expressions are checked when you save.
          </p>
        </div>
        {rules.map((rule, i) => (
          <div className="panel" key={i}>
            <div className="field">
              <label htmlFor={`rule-${i}-types`}>Rule {i + 1} · event types</label>
              <textarea
                id={`rule-${i}-types`}
                className="short"
                spellCheck={false}
                value={rule.types}
                onChange={(e) => setRule(i, { types: e.target.value })}
                placeholder="com.github.*"
              />
              <p className="hint">One glob per line; * is any run of characters.</p>
            </div>
            {EXPRESSIONS.map(({ key, label, hint }) => (
              <div className="field" key={key}>
                <label htmlFor={`rule-${i}-${key}`}>{label}</label>
                <div className="input-wrap">
                  <input
                    id={`rule-${i}-${key}`}
                    spellCheck={false}
                    maxLength={2000}
                    value={rule[key]}
                    onChange={(e) => setRule(i, { [key]: e.target.value })}
                  />
                </div>
                <p className="hint">{hint}</p>
              </div>
            ))}
            <div className="form-actions">
              <button
                className="btn btn-sm btn-quiet"
                type="button"
                onClick={() => setRules(rules.filter((_, n) => n !== i))}
              >
                Remove rule
              </button>
            </div>
          </div>
        ))}
        <div className="form-actions">
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => setRules([...rules, { types: "", subject: "", related: "", action: "" }])}
          >
            Add rule
          </button>
        </div>
        <div className="form-actions">
          <button className="btn" type="submit">
            Save as new version
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {saved && <p className="hint">Saved version {saved}.</p>}
      </form>

      <div className="page-head section">
        <h1>History</h1>
      </div>
      <ul className="list">
        {history.data?.map((v) => (
          <li key={v.version}>
            <details className="message">
              <summary>
                <span className="type">Version {v.version}</span>
                <span className="when">{lw.when(v.created_at)}</span>
              </summary>
              <pre>{v.prompt}</pre>
              {v.rules?.length ? v.rules.map((r, i) => <RuleSummary key={i} rule={r} />) : <pre>No rules.</pre>}
              {v.version !== current?.version && (
                <div className="actions">
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={() => void save({ prompt: v.prompt, rules: v.rules ?? undefined }, v.version)}
                  >
                    Restore
                  </button>
                </div>
              )}
            </details>
          </li>
        ))}
      </ul>
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
    <DashLayout
      title="Thread · loopway"
      me={me}
      crumb={
        <p className="crumb">
          <a href={"/dashboard/bots/" + botId}>← {bot.data?.name ?? "Bot"}</a>
        </p>
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
    </DashLayout>
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
