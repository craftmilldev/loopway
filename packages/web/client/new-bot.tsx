import { useEffect, useState, type FormEvent } from "react";
import { PRESETS } from "@loopway/presets";
import { HarnessRequest } from "../ee/client/harness-request.js";
import { CreateInbox, type Inbox } from "./shared.js";
import { DashLayout } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";
import { fromDrafts, problem, PromptEditor, type RuleDraft } from "./prompt.js";

const STEPS = ["Connect a source", "Choose its job", "Name and model", "Start a runner", "Watch the first run"];

/** When to pick each model alias. */
const MODEL_USE: Record<string, string> = {
  best: "The strongest model your account has",
  sonnet: "The usual choice",
  opus: "Harder problems, slower",
  fable: "The newest family",
  haiku: "Quick, simple jobs",
};
const MODELS = lw.BOT_MODELS.filter((m) => m in MODEL_USE);

/** How often steps 4 and 5 look at the bot again, in milliseconds. */
const POLL = 3000;

/** The starting point that isn't a preset: the user writes the prompt and rules here, before the bot exists. */
const BLANK = "blank";

/** `/<org>/bots/new`: the guided flow from a source to a bot's first thread. `?bot=<id>` resumes a created bot. */
export function NewBot() {
  const me = lw.useMe();
  const ready = !!me;
  const inboxes = lw.useList<Inbox>("/inboxes", ready);
  const orgs = lw.useOrgs(ready);
  const org = orgs ? lw.startOrg(orgs) : "";
  // Read once: creating the bot rewrites the URL, and that must not count as a resume.
  const [resumeId] = useState(() => new URLSearchParams(location.search).get("bot"));
  const [botId, setBotId] = useState(resumeId);
  const [step, setStep] = useState(1);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preset, setPreset] = useState(Object.keys(PRESETS)[0]!);
  const [blankPrompt, setBlankPrompt] = useState("");
  const [blankRules, setBlankRules] = useState<RuleDraft[]>([]);
  const [name, setName] = useState("");
  const [model, setModel] = useState("sonnet");
  const bot = lw.useGet<lw.Bot>(botId ? "/bots/" + encodeURIComponent(botId) : null, ready);

  // A reload or a link with `?bot=` lands on the first step that still has something to do.
  const [resumed, setResumed] = useState(false);
  useEffect(() => {
    if (!resumeId || resumed) return;
    if (bot.missing) {
      track("new_bot_resume_failed");
      setBotId(null);
      setResumed(true);
    } else if (bot.data) {
      const at = bot.data.leased_until ? 5 : 4;
      track("new_bot_resumed", { step: at });
      setStep(at);
      setResumed(true);
    }
  }, [resumeId, resumed, bot.missing, bot.data]);

  const loading = !!resumeId && !resumed;

  return (
    <DashLayout title="New bot · loopway" me={me}>
      <div className="page-head">
        <h1>Put a bot to work</h1>
      </div>
      <p className="muted">Five steps. You can change every answer later.</p>
      <div className="newbot">
        <ol className="steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li
              key={s}
              aria-current={step === i + 1 ? "step" : undefined}
              className={step > i + 1 ? "done" : undefined}
            >
              <span className="n">{step > i + 1 ? "✓" : i + 1}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
        <div className="step-body">
          {loading || !inboxes.data || !orgs ? (
            <p className="muted">Loading…</p>
          ) : step === 1 ? (
            <Source
              orgs={orgs}
              org={org}
              inboxes={inboxes.data}
              picked={picked}
              setPicked={setPicked}
              reload={inboxes.reload}
              next={() => setStep(2)}
            />
          ) : step === 2 ? (
            <Job
              preset={preset}
              setPreset={setPreset}
              prompt={blankPrompt}
              setPrompt={setBlankPrompt}
              rules={blankRules}
              setRules={setBlankRules}
              back={() => setStep(1)}
              next={() => setStep(3)}
            />
          ) : step === 3 ? (
            <Identity
              name={name}
              setName={setName}
              model={model}
              setModel={setModel}
              preset={preset}
              blank={{ prompt: blankPrompt, rules: fromDrafts(blankRules) }}
              org={org}
              inbox_ids={[...picked]}
              existing={bot.data}
              back={() => setStep(2)}
              next={() => setStep(4)}
              created={(b) => {
                history.replaceState(null, "", lw.orgBase() + "/bots/new?bot=" + encodeURIComponent(b.id));
                setBotId(b.id);
                setStep(4);
              }}
            />
          ) : step === 4 ? (
            <Runner bot={bot.data} reload={bot.reload} back={() => setStep(3)} next={() => setStep(5)} />
          ) : (
            <FirstRun botId={botId!} />
          )}
        </div>
      </div>
    </DashLayout>
  );
}

function Source({
  orgs,
  org,
  inboxes,
  picked,
  setPicked,
  reload,
  next,
}: {
  orgs: lw.Org[];
  org: string;
  inboxes: Inbox[];
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
  reload: () => Promise<unknown>;
  next: () => void;
}) {
  // A bot reads inboxes of its own org only, so the list is the chosen org's.
  const orgId = orgs.find((o) => o.slug === org)?.id;
  const inOrg = inboxes.filter((i) => i.org_id === orgId);
  const [creating, setCreating] = useState(inOrg.length === 0);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string, on: boolean) {
    const s = new Set(picked);
    if (on) s.add(id);
    else s.delete(id);
    setPicked(s);
  }

  function go() {
    if (!picked.size) {
      track("new_bot_no_inbox");
      return setError("Pick or create at least one inbox.");
    }
    next();
  }

  return (
    <section>
      <h2>Where do its messages come from?</h2>
      {inOrg.length > 0 && (
        <div className="options">
          {inOrg.map((i) => (
            <label key={i.id} className="opt">
              <input type="checkbox" checked={picked.has(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} />
              <span>
                {i.name}
                <span className="muted"> · {i.source_type}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {creating ? (
        <CreateInbox
          onCreated={(i) => {
            track("new_bot_inbox_created", { source_type: i.source_type });
            setCreating(false);
            setPicked(new Set(picked).add(i.id));
            void reload();
          }}
        />
      ) : (
        <button className="btn btn-sm btn-quiet" type="button" onClick={() => setCreating(true)}>
          Create a new inbox
        </button>
      )}
      {inOrg
        .filter((i) => picked.has(i.id))
        .map((i) => (
          <div key={i.id} className="field">
            <label>Webhook URL for {i.name}</label>
            <Copy text={i.webhook_url} />
          </div>
        ))}
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button className="btn" type="button" onClick={go}>
          Continue
        </button>
      </div>
    </section>
  );
}

function Copy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy">
      <code>{text}</code>
      <button
        className="btn btn-sm btn-quiet"
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Job({
  preset,
  setPreset,
  prompt,
  setPrompt,
  rules,
  setRules,
  back,
  next,
}: {
  preset: string;
  setPreset: (p: string) => void;
  prompt: string;
  setPrompt: (p: string) => void;
  rules: RuleDraft[];
  setRules: (r: RuleDraft[]) => void;
  back: () => void;
  next: () => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (preset === BLANK) {
      const bad = problem(prompt, fromDrafts(rules));
      if (bad) {
        track("new_bot_blank_blocked", { reason: bad.reason });
        return setError(bad.message);
      }
    }
    track("new_bot_preset_chosen", { preset });
    next();
  }

  return (
    <section>
      <h2>What should it do with those messages?</h2>
      <p className="muted">
        A starting point fills in the bot's prompt and its routing rules. The bot keeps its own copy, so you can edit it
        afterwards.
      </p>
      <fieldset className="options">
        <legend className="lbl">Starting point</legend>
        {Object.entries(PRESETS).map(([k, p]) => (
          <label key={k} className="opt">
            <input type="radio" name="preset" checked={preset === k} onChange={() => setPreset(k)} />
            <span>
              {p.label}
              <span className="muted"> {p.description}</span>
            </span>
          </label>
        ))}
        <label className="opt">
          <input type="radio" name="preset" checked={preset === BLANK} onChange={() => setPreset(BLANK)} />
          <span>
            Blank
            <span className="muted"> Write the prompt and the routing rules yourself.</span>
          </span>
        </label>
      </fieldset>
      {preset === BLANK && (
        <PromptEditor
          prompt={prompt}
          setPrompt={setPrompt}
          rules={rules}
          setRules={setRules}
          editing={editing}
          setEditing={setEditing}
        />
      )}
      {error && preset === BLANK && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button className="btn btn-quiet" type="button" onClick={back}>
          Back
        </button>
        <button className="btn" type="button" onClick={submit}>
          Continue
        </button>
      </div>
    </section>
  );
}

function Identity({
  name,
  setName,
  model,
  setModel,
  preset,
  blank,
  org,
  inbox_ids,
  existing,
  back,
  next,
  created,
}: {
  name: string;
  setName: (n: string) => void;
  model: string;
  setModel: (m: string) => void;
  preset: string;
  blank: { prompt: string; rules: lw.BotRule[] };
  org: string;
  inbox_ids: string[];
  existing: lw.Bot | null;
  back: () => void;
  next: () => void;
  created: (b: lw.Bot) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const can_request = lw.useSources()?.can_request;
  const [other, setOther] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Going back from step 4 doesn't make a second bot.
    if (existing) return next();
    setError(null);
    setBusy(true);
    const { prompt, rules } = preset === BLANK ? blank : PRESETS[preset]!;
    const r = await lw.api("/bots", {
      method: "POST",
      body: { org, name, prompt, rules, model, harness: "claude", inbox_ids },
    });
    setBusy(false);
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) {
      track("bot_create_rejected", { status: r.status });
      return setError(await lw.message(r));
    }
    lw.rememberOrg(org);
    track("new_bot_created", { preset, model });
    created((await r.json()) as lw.Bot);
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <h2>Name it and pick a model</h2>
      <div className="field">
        <label htmlFor="bot-name">Name</label>
        <div className="input-wrap">
          <input
            id="bot-name"
            required
            maxLength={200}
            disabled={!!existing}
            value={existing ? existing.name : name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <p className="hint">
          Shown on threads and in <code>loopway bots run</code>.
        </p>
      </div>
      <fieldset className="options">
        <legend className="lbl">Harness</legend>
        <label className="opt">
          <input type="radio" name="harness" checked={!other} onChange={() => setOther(false)} />
          <span>Claude Code</span>
        </label>
        {can_request && !existing && (
          <label className="opt">
            <input
              type="radio"
              name="harness"
              checked={other}
              onChange={() => {
                track("new_bot_harness_other_opened");
                setOther(true);
              }}
            />
            <span>Something else…</span>
          </label>
        )}
      </fieldset>
      {other && !existing && <HarnessRequest />}
      <fieldset className="models">
        <legend className="lbl">Model</legend>
        {MODELS.map((m) => (
          <label key={m} className={"model" + ((existing?.model ?? model) === m ? " on" : "")}>
            <span>
              <input
                type="radio"
                name="model"
                disabled={!!existing}
                checked={(existing?.model ?? model) === m}
                onChange={() => setModel(m)}
              />{" "}
              {m}
            </span>
            <span className="muted">{MODEL_USE[m]}</span>
          </label>
        ))}
      </fieldset>
      {existing && <p className="hint">The bot is created. Change its name, model or prompt on its page.</p>}
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        {!existing && (
          <button className="btn btn-quiet" type="button" onClick={back}>
            Back
          </button>
        )}
        <button className="btn" type="submit" disabled={busy}>
          {existing ? "Continue" : "Create bot and continue"}
        </button>
      </div>
    </form>
  );
}

function Runner({
  bot,
  reload,
  back,
  next,
}: {
  bot: lw.Bot | null;
  reload: () => Promise<unknown>;
  back: () => void;
  next: () => void;
}) {
  const leased = !!bot?.leased_until;
  useEffect(() => {
    if (leased) return track("new_bot_runner_leased");
    const t = setInterval(() => void reload(), POLL);
    return () => clearInterval(t);
  }, [leased, reload]);

  return (
    <section>
      <h2>Start a runner</h2>
      <p className="muted">
        Bots run on your own machine, in the repository they work on. Run this there and leave it open.
      </p>
      <div className="add-runner">
        <code>$ curl -fsSL https://loopway.craftmill.dev/install.sh | sh &amp;&amp; loopway login</code>
        <code>$ cd ~/code/your-repo &amp;&amp; loopway bots run --org {lw.orgSlug()}</code>
        <span className="lbl" role="status">
          {leased ? "A runner took the lease. Your bot is running." : "Listening for a runner to take the lease…"}
        </span>
      </div>
      <div className="form-actions">
        <button className="btn btn-quiet" type="button" onClick={back}>
          Back
        </button>
        <button className="btn" type="button" onClick={next}>
          {leased ? "Continue" : "Skip for now"}
        </button>
      </div>
    </section>
  );
}

function FirstRun({ botId }: { botId: string }) {
  const [threads, setThreads] = useState<lw.Thread[]>([]);
  useEffect(() => {
    async function load() {
      const r = await lw.api(`/bots/${encodeURIComponent(botId)}/threads`);
      if (r.ok) setThreads(((await r.json()) as { data: lw.Thread[] }).data);
    }
    void load();
    const t = setInterval(() => void load(), POLL);
    return () => clearInterval(t);
  }, [botId]);
  const first = threads[0];
  useEffect(() => {
    if (first) track("new_bot_first_thread");
  }, [first]);

  return (
    <section>
      <h2>Watch the first run</h2>
      <p className="muted">
        Give the bot something to do: make something happen in the source you connected, such as opening an issue in a
        GitHub repository. The thread appears here as soon as the runner picks it up.
      </p>
      {first ? (
        <p>
          <a
            className="btn"
            href={`${lw.orgBase()}/bots/${encodeURIComponent(botId)}/threads/${encodeURIComponent(first.id)}`}
          >
            Open the first thread
          </a>
        </p>
      ) : (
        <p className="muted" role="status">
          Waiting for the first thread…
        </p>
      )}
      <p>
        <a href={`${lw.orgBase()}/bots/${encodeURIComponent(botId)}`}>Go to the bot's page</a>
      </p>
    </section>
  );
}
