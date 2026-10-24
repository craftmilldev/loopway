import { useEffect, useState } from "react";
import { changed, lineDiff, type DiffLine } from "./diff.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

/** A rule as the form edits it: every field is text, and the type globs are one per line. */
export interface RuleDraft {
  types: string;
  subject: string;
  related: string;
  authorKind: string;
  action: string;
}

const EXPRESSIONS = [
  { key: "subject", label: "Subject", hint: 'CEL: the message\'s own subject, "" for none.' },
  { key: "related", label: "Related", hint: "CEL: a list of other subjects the message names." },
  {
    key: "authorKind",
    label: "Author kind",
    hint: "CEL: 'human' or 'bot' for who made the message, \"\" for unknown. Sets the thread's level of automation.",
  },
  { key: "action", label: "Action", hint: "CEL, required: 'attach' or 'skip'." },
] as const;

/** The two actions with a radio of their own; any other action is an expression. */
const ACTIONS = [
  { choice: "attach", label: "Attach", value: "'attach'" },
  { choice: "skip", label: "Skip", value: "'skip'" },
] as const;

/** A new rule sends its matching messages to the bot. */
const blankRule = (): RuleDraft => ({ types: "", subject: "", related: "", authorKind: "", action: "'attach'" });

export const toDrafts = (rules: lw.BotRule[] | null): RuleDraft[] =>
  (rules ?? []).map((r) => ({
    types: r.types.join("\n"),
    subject: r.subject ?? "",
    related: r.related ?? "",
    authorKind: r.authorKind ?? "",
    action: r.action ?? "",
  }));

export const fromDrafts = (drafts: RuleDraft[]): lw.BotRule[] =>
  drafts.map((d) => {
    const rule: lw.BotRule = {
      types: d.types
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean),
      action: d.action.trim(),
    };
    for (const { key } of EXPRESSIONS) if (key !== "action" && d[key].trim()) rule[key] = d[key].trim();
    return rule;
  });

/** Rules in one canonical shape: types and expressions trimmed, empty ones dropped, keys in a fixed order. */
export const normalizeRules = (rules: lw.BotRule[] | null): lw.BotRule[] => fromDrafts(toDrafts(rules));

/** Whether two rule lists are the same rules in the same order, ignoring key order, padding and null versus []. */
export const sameRules = (a: lw.BotRule[] | null, b: lw.BotRule[] | null) => {
  const x = normalizeRules(a);
  const y = normalizeRules(b);
  return (
    x.length === y.length &&
    x.every(
      (r, i) =>
        r.types.length === y[i]!.types.length &&
        r.types.every((t, n) => t === y[i]!.types[n]) &&
        EXPRESSIONS.every(({ key }) => r[key] === y[i]![key]),
    )
  );
};

/** Whether two prompts are the same text, ignoring the line endings a textarea normalizes. */
export const samePrompt = (a: string, b: string) => a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n");

/** Rules as plain lines, one block per rule, for diffing. */
export const rulesText = (rules: lw.BotRule[] | null) =>
  normalizeRules(rules)
    .map((r, i) =>
      [
        `Rule ${i + 1}`,
        "  types: " + r.types.join(", "),
        ...EXPRESSIONS.filter(({ key }) => r[key]).map(({ key }) => `  ${key}: ${r[key]}`),
      ].join("\n"),
    )
    .join("\n");

/** The first thing wrong with a draft that the API would refuse, in its words, else null. */
export function problem(prompt: string, rules: lw.BotRule[]): { reason: string; message: string } | null {
  if (!prompt.trim()) return { reason: "no_prompt", message: "Write a prompt." };
  if (!rules.length) return { reason: "no_rules", message: "Add at least one rule." };
  const empty = rules.findIndex((r) => !r.types.length);
  if (empty >= 0) return { reason: "rule_missing_types", message: `Rule ${empty + 1} needs at least one event type.` };
  const noAction = rules.findIndex((r) => !r.action);
  if (noAction >= 0)
    return {
      reason: "rule_missing_action",
      message: `Rule ${noAction + 1} needs an action: choose Attach to send matching messages to the bot.`,
    };
  return null;
}

function Diff({ lines, label }: { lines: DiffLine[]; label: string }) {
  return (
    <div className="diff" role="group" aria-label={label}>
      {lines.map((l, i) => (
        <div key={i} className={"diff-line " + l.kind}>
          {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
          {l.text}
        </div>
      ))}
    </div>
  );
}

/** The prompt box and the rule list, as a controlled form; the bot's prompt page and the new-bot flow both edit with it. */
export function PromptEditor({
  prompt,
  setPrompt,
  rules,
  setRules,
  editing,
  setEditing,
  from,
  note,
}: {
  prompt: string;
  setPrompt: (p: string) => void;
  rules: RuleDraft[];
  setRules: (r: RuleDraft[]) => void;
  editing: number | null;
  setEditing: (i: number | null) => void;
  /** Where the editor is, for metrics. */
  from: "new_bot" | "prompt_tab";
  /** A line under the rules, e.g. on where the first one came from. */
  note?: string;
}) {
  const parsed = fromDrafts(rules);

  const setRule = (i: number, patch: Partial<RuleDraft>) =>
    setRules(rules.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  function addRule() {
    track("bot_rule_added");
    setRules([...rules, blankRule()]);
    setEditing(rules.length);
  }

  function removeRule(i: number) {
    track("bot_rule_removed");
    setRules(rules.filter((_, n) => n !== i));
    setEditing(null);
  }

  function move(i: number, by: -1 | 1) {
    track("bot_rule_moved");
    const j = i + by;
    const copy = [...rules];
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    setRules(copy);
    setEditing(editing === i ? j : editing === j ? i : editing);
  }

  return (
    <>
      <div className="field">
        <div className="prompt-head">
          <label htmlFor="bot-prompt">Prompt</label>
          <span className="muted mono">{prompt.length.toLocaleString()} characters</span>
        </div>
        <textarea
          id="bot-prompt"
          className="prompt"
          spellCheck={false}
          maxLength={100_000}
          value={prompt}
          placeholder="What should this bot do with each message?"
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>

      <div className="prompt-head section">
        <h2>Rules</h2>
        <button className="btn btn-sm btn-quiet" type="button" onClick={addRule}>
          Add rule
        </button>
      </div>
      <p className="hint">
        The first rule whose event types match a message applies. The expressions are checked when you save.
      </p>
      {rules.length === 0 && <p className="muted">No rules.</p>}
      {rules.length > 0 && note && <p className="hint">{note}</p>}
      {rules.map((rule, i) => (
        <div className="rule" key={i}>
          <span className="rule-n">{i + 1}</span>
          <div className="rule-body">
            {editing === i ? (
              <RuleForm index={i} rule={rule} from={from} onChange={(patch) => setRule(i, patch)} />
            ) : (
              <RuleBlock rule={parsed[i]!} />
            )}
          </div>
          <div className="rule-actions">
            <button className="btn btn-sm btn-quiet" type="button" onClick={() => setEditing(editing === i ? null : i)}>
              {editing === i ? "Done" : "Edit"}
              <span className="sr-only"> rule {i + 1}</span>
            </button>
            <button
              className="btn btn-sm btn-quiet"
              type="button"
              disabled={i === 0}
              aria-label={`Move rule ${i + 1} up`}
              onClick={() => move(i, -1)}
            >
              ↑
            </button>
            <button
              className="btn btn-sm btn-quiet"
              type="button"
              disabled={i === rules.length - 1}
              aria-label={`Move rule ${i + 1} down`}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
            <button className="btn btn-sm btn-quiet" type="button" onClick={() => removeRule(i)}>
              Remove<span className="sr-only"> rule {i + 1}</span>
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

/** Prompt and rules as a document: edits make a draft, saving makes the next version, and old versions can be compared and restored. */
export function PromptTab({
  botPath,
  current,
  onSaved,
}: {
  botPath: string;
  current: lw.BotVersion | null;
  onSaved: () => void;
}) {
  const [prompt, setPrompt] = useState(current?.prompt ?? "");
  const [rules, setRules] = useState(toDrafts(current?.rules ?? null));
  const [editing, setEditing] = useState<number | null>(null);
  const [comparing, setComparing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const version = current?.version;
  const next = (version ?? 0) + 1;

  // A new current version (saved here, or by the CLI) fills the editor.
  useEffect(() => {
    setPrompt(current?.prompt ?? "");
    setRules(toDrafts(current?.rules ?? null));
    setEditing(null);
    setSaving(false);
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = fromDrafts(rules);
  const promptChanged = !samePrompt(prompt, current?.prompt ?? "");
  const rulesChanged = !sameRules(parsed, current?.rules ?? null);
  const dirty = promptChanged || rulesChanged;
  const history = lw.useList<lw.BotVersion>(botPath + "/versions", true);

  useEffect(() => {
    if (!dirty) return;
    track("prompt_draft_started");
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function discard() {
    track("prompt_draft_discarded");
    setPrompt(current?.prompt ?? "");
    setRules(toDrafts(current?.rules ?? null));
    setEditing(null);
    setError(null);
  }

  function restore(v: lw.BotVersion) {
    track("bot_version_restored");
    setPrompt(v.prompt);
    setRules(toDrafts(v.rules));
    setEditing(null);
    setComparing(null);
    setError(null);
  }

  function compare(v: lw.BotVersion) {
    if (comparing === v.version) return setComparing(null);
    track("bot_version_compared");
    setComparing(v.version);
  }

  async function save() {
    setError(null);
    const bad = problem(prompt, parsed);
    if (bad) {
      track("bot_version_save_blocked", { reason: bad.reason });
      return setError(bad.message);
    }
    setSaving(true);
    const r = await lw.api(botPath + "/versions", { method: "POST", body: { prompt, rules: parsed } });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) {
      setSaving(false);
      track("bot_version_save_failed", { status: r.status });
      return setError(await lw.message(r));
    }
    track("bot_version_saved_from_draft");
    onSaved();
    void history.reload();
  }

  const compared = history.data?.find((v) => v.version === comparing);

  return (
    <>
      {dirty && (
        <section className="draft-bar" aria-label="Draft">
          <div>
            <strong>Draft of version {next}</strong>{" "}
            <span className="muted">
              {[promptChanged && "prompt changed", rulesChanged && "rules changed"].filter(Boolean).join(" · ")} · new
              threads pick it up; running ones keep version {version ?? "their own"}
            </span>
          </div>
          <div className="form-actions">
            <button className="btn btn-quiet" type="button" onClick={discard}>
              Discard
            </button>
            <button className="btn" type="button" disabled={saving} onClick={() => void save()}>
              Save as version {next}
            </button>
          </div>
        </section>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="ov-split bot-split">
        <div className="ov-main">
          <PromptEditor
            prompt={prompt}
            setPrompt={setPrompt}
            rules={rules}
            setRules={setRules}
            editing={editing}
            setEditing={setEditing}
            from="prompt_tab"
          />
        </div>
        <aside className="ov-side">
          <h2>Versions</h2>
          <ul className="list">
            {history.data?.map((v) => (
              <li key={v.version} className="version-row">
                <span>
                  Version {v.version}
                  {v.version === version && <span className="badge">current</span>}{" "}
                  <span className="muted">{lw.when(v.created_at)}</span>
                </span>
                {v.version !== version && (
                  <span className="actions">
                    <button
                      className="btn btn-sm btn-quiet"
                      type="button"
                      aria-pressed={comparing === v.version}
                      aria-label={`Compare version ${v.version}`}
                      onClick={() => compare(v)}
                    >
                      Compare
                    </button>{" "}
                    <button
                      className="btn btn-sm btn-quiet"
                      type="button"
                      aria-label={`Restore version ${v.version}`}
                      onClick={() => restore(v)}
                    >
                      Restore
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {history.data?.length === 0 && <p className="muted">No versions yet.</p>}
          <p className="hint">Restoring loads a version into the draft. Saving it makes a new version.</p>
          {compared && current && <VersionDiff from={compared} to={current} />}
        </aside>
      </div>
    </>
  );
}

function VersionDiff({ from, to }: { from: lw.BotVersion; to: lw.BotVersion }) {
  const prompt = lineDiff(from.prompt, to.prompt);
  const rules = lineDiff(rulesText(from.rules), rulesText(to.rules));
  return (
    <div className="diffs">
      <h2>
        Version {from.version} → {to.version}
      </h2>
      <span className="lbl">Prompt</span>
      {changed(prompt) ? <Diff lines={prompt} label="Prompt changes" /> : <p className="muted">Same prompt.</p>}
      <span className="lbl">Rules</span>
      {changed(rules) ? <Diff lines={rules} label="Rule changes" /> : <p className="muted">Same rules.</p>}
    </div>
  );
}

/** A rule at rest: its event types as chips, then the fields it sets. */
function RuleBlock({ rule }: { rule: lw.BotRule }) {
  return (
    <>
      <div className="thread-meta">
        {rule.types.length ? (
          rule.types.map((t) => (
            <span className="chip" key={t}>
              {t}
            </span>
          ))
        ) : (
          <span className="muted">No event types yet</span>
        )}
      </div>
      <dl className="kv">
        {EXPRESSIONS.filter(({ key }) => rule[key]).map(({ key, label }) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{rule[key]}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function RuleForm({
  index,
  rule,
  from,
  onChange,
}: {
  index: number;
  rule: RuleDraft;
  from: "new_bot" | "prompt_tab";
  onChange: (patch: Partial<RuleDraft>) => void;
}) {
  // Set by the Expression radio, so typing `'attach'` into the box doesn't swap it for the Attach radio mid-edit.
  const [expression, setExpression] = useState(!ACTIONS.some((a) => a.value === rule.action.trim()));
  const isExpression = expression || !ACTIONS.some((a) => a.value === rule.action.trim());

  function choose(choice: "attach" | "skip" | "expression", action: string) {
    track("bot_rule_action_chosen", { choice, from });
    setExpression(choice === "expression");
    onChange({ action });
  }

  const field = ({ key, label, hint }: (typeof EXPRESSIONS)[number]) => (
    <div className="field" key={key}>
      <label htmlFor={`rule-${index}-${key}`}>{label}</label>
      <div className="input-wrap">
        <input
          id={`rule-${index}-${key}`}
          spellCheck={false}
          maxLength={2000}
          value={rule[key]}
          onChange={(e) => onChange({ [key]: e.target.value })}
        />
      </div>
      <p className="hint">{hint}</p>
    </div>
  );

  return (
    <>
      <div className="field">
        <label htmlFor={`rule-${index}-types`}>Rule {index + 1} · event types</label>
        <textarea
          id={`rule-${index}-types`}
          className="short"
          spellCheck={false}
          value={rule.types}
          onChange={(e) => onChange({ types: e.target.value })}
          placeholder="com.github.*"
        />
        <p className="hint">One glob per line; * is any run of characters.</p>
      </div>
      <fieldset className="options">
        <legend className="lbl">Action</legend>
        {ACTIONS.map(({ choice, label, value }) => (
          <label key={choice} className="opt">
            <input
              type="radio"
              name={`rule-${index}-action`}
              checked={!isExpression && rule.action.trim() === value}
              onChange={() => choose(choice, value)}
            />
            <span>{label}</span>
          </label>
        ))}
        <label className="opt">
          <input
            type="radio"
            name={`rule-${index}-action`}
            checked={isExpression}
            onChange={() => choose("expression", "")}
          />
          <span>Expression…</span>
        </label>
      </fieldset>
      {isExpression && field(EXPRESSIONS[3])}
      <details>
        <summary>Thread grouping (optional)</summary>
        {EXPRESSIONS.slice(0, 3).map(field)}
      </details>
    </>
  );
}
