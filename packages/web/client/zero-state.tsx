import { Fragment, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { agentPrompt } from "./agent-prompt.js";
import { commands } from "./runners.js";
import { DashLayout, MembersHint, OrgsContext } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";
import { TestMessageButton } from "./test-message.js";

/** The three steps of the zero state, each done once its condition holds. */
export interface SetupProgress {
  /** A runner is connected (or a bot has run, which needs one): it holds its lease (the same "online" as the runners page), so one that registered once and was closed doesn't count. */
  runner: boolean;
  /** The org has a bot. */
  bot: boolean;
  /** A bot has handled its first message. */
  ran: boolean;
}

export const setupDone = (p: SetupProgress) => p.runner && p.bot && p.ran;

/** The first step not done, 0 to 2. */
const currentStep = (p: SetupProgress) => (!p.runner ? 0 : !p.bot ? 1 : 2);

/**
 * How far the org's setup is. Polled, so the page moves on without a refresh, until all three steps are done. Null
 * until the first load settles; false if that load fails, so the pages show as usual. A failed poll after that keeps
 * what it had.
 */
export function useSetupProgress(enabled: boolean): SetupProgress | false | null {
  const [progress, setProgress] = useState<SetupProgress | false | null>(null);
  // The events already sent; an org whose first load finds the setup finished was never in the zero state and sends none.
  const sent = useRef({ runner: false, bot: false, ran: false, completed: false });
  const first = useRef(true);
  const load = useCallback(async () => {
    const get = async <T,>(path: string) => {
      const r = await lw.api(lw.inOrg(path)).catch(() => null);
      return r?.ok ? ((await r.json().catch(() => null)) as { data?: T[] } | null)?.data : undefined;
    };
    const [bots, runners, activity] = await Promise.all([
      get<unknown>("/bots"),
      get<lw.Runner>("/runners"),
      get<lw.BotActivity>("/bots/activity?days=1"),
    ]);
    const wasFirst = first.current;
    first.current = false;
    if (!bots || !runners || !activity) {
      if (wasFirst) setProgress(false);
      return false;
    }
    // A bot that has run proves a runner connected once, so an established org whose runner is closed isn't sent back.
    const ran = activity.some((a) => a.last_delivery_at);
    const next = { runner: ran || runners.some((r) => r.leased_until), bot: bots.length > 0, ran };
    const done = sent.current;
    if (wasFirst && setupDone(next)) Object.assign(done, { ...next, completed: true });
    for (const [step, event] of [
      ["runner", "zero_state_runner_connected"],
      ["bot", "zero_state_bot_created"],
      ["ran", "zero_state_first_run"],
    ] as const) {
      if (next[step] && !done[step]) {
        done[step] = true;
        track(event);
      }
    }
    if (setupDone(next) && !done.completed) {
      done.completed = true;
      track("zero_state_completed");
    }
    setProgress(next);
    return true;
  }, []);
  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);
  lw.usePoll(load, enabled && progress !== false && !(progress && setupDone(progress)));
  return progress;
}

const STEPS = ["Get loopway running", "Make your first bot", "See it run"];

const Check = ({ size = 11 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={Math.round((size * 9) / 11)} viewBox="0 0 11 9">
    <path d="M1 4.5l3 3 6-6" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

/** The three steps as a strip of cells: finished ones say done, the first one not done is inked. */
function SetupSteps({ progress }: { progress: SetupProgress }) {
  const current = progress.runner && progress.bot && progress.ran ? -1 : currentStep(progress);
  const done = [progress.runner, progress.bot, progress.ran];
  return (
    <nav className="zs-rail" aria-label="Setup steps">
      <ol aria-label="Setup progress">
        {STEPS.map((label, i) => (
          <li key={label} className={done[i] ? "done" : undefined} aria-current={i === current ? "step" : undefined}>
            <span className="zs-rail-top">
              <span>Step {i + 1}</span>
              <span className="zs-rail-state">
                {done[i] ? (
                  <>
                    <Check />
                    done
                  </>
                ) : i === current ? (
                  "now"
                ) : i === current + 1 ? (
                  "next"
                ) : (
                  "after that"
                )}
              </span>
            </span>
            <span className="zs-rail-title">{label}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

interface Box {
  title: string;
  caption: string;
  /** Inked solid: the part this step is about. */
  inked?: boolean;
  /** The caption in indigo, for a part that is ready. */
  ready?: boolean;
}

/** The idea drawn once: four boxes joined by lines, the ones this step is about inked. Scrolls sideways on a phone. */
function Diagram({ boxes }: { boxes: Box[] }) {
  return (
    <div className="zs-diagram-wrap">
      <div className="zs-diagram">
        {boxes.map((b, i) => (
          <Fragment key={b.title}>
            {i > 0 && (
              <div className="zs-join" aria-hidden="true">
                <span />
                <svg width="8" height="12" viewBox="0 0 8 12">
                  <path d="M1 1l6 5-6 5" fill="none" stroke="currentColor" strokeWidth="1.2" />
                </svg>
              </div>
            )}
            <div className={"zs-box" + (b.inked ? " inked" : "") + (b.ready ? " ready" : "")}>
              <span className="zs-box-title">{b.title}</span>
              <span className="zs-box-caption">{b.caption}</span>
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function Lede({
  eyebrow,
  title,
  children,
  diagram,
  big,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
  diagram?: Box[];
  big?: boolean;
}) {
  return (
    <section className="zs-lede" aria-labelledby="zs-title">
      <div className="zs-wrap">
        <p className="zs-eyebrow">{eyebrow}</p>
        <h1 id="zs-title" className={big ? "big" : undefined}>
          {title}
        </h1>
        {children && <p className="zs-lede-text">{children}</p>}
        {diagram && <Diagram boxes={diagram} />}
      </div>
    </section>
  );
}

function Waiting({ what, children }: { what: string; children: ReactNode }) {
  return (
    <div className="zs-waiting" role="status">
      <span className="zs-waiting-what">
        <span className="zs-waiting-mark" aria-hidden="true" />
        {what}
      </span>
      <span className="zs-waiting-note">{children}</span>
    </div>
  );
}

function Notes({ label, notes }: { label: string; notes: { title: string; body: ReactNode }[] }) {
  return (
    <section className="zs-notes" aria-label={label}>
      <div className="zs-wrap">
        {notes.map((n) => (
          <div key={n.title}>
            <span className="zs-note-label">{n.title}</span>
            <p>{n.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

type Copied = "install" | "login" | "run" | "all" | "prompt" | "webhook_url";

/** Copies `text` and counts it; false (and counts the failure) if the browser refuses. */
async function copyText(text: string, what: Copied) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    track("zero_state_copy_failed", { what });
    return false;
  }
  track("zero_state_copy", { what });
  return true;
}

function CopyButton({
  text,
  what,
  className,
  label = "Copy",
}: {
  text: string;
  what: Copied;
  className: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={className}
      type="button"
      onClick={() =>
        void copyText(text, what).then((ok) => {
          if (ok) setCopied(true);
        })
      }
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** An ink panel holding one thing to copy; `prompt` is shown before it and not copied. */
function CommandPanel({ text, what, prompt }: { text: string; what: Copied; prompt?: string }) {
  return (
    <div className="zs-panel">
      {prompt && <span className="zs-panel-prompt">{prompt}</span>}
      <code>{text}</code>
      <CopyButton text={text} what={what} className="zs-ghost" />
    </div>
  );
}

const README = "https://github.com/craftmilldev/loopway#readme";

function ReadmeLink({ children = "README", hash = "" }: { children?: ReactNode; hash?: string }) {
  return (
    <a href={README + hash} target="_blank" rel="noreferrer" onClick={() => track("zero_state_readme_clicked")}>
      {children}
    </a>
  );
}

const SOURCES: Record<string, string> = { github: "GitHub", linear: "Linear", vercel: "Vercel" };
const sourceLabel = (type: string) => SOURCES[type] ?? type;

/** What the later steps name: the first online runner, the org's first bot and its first inbox, and the first run. */
interface Facts {
  runner: lw.Runner | null;
  bot: lw.Bot | null;
  inbox: Inbox | null;
  firstRun: lw.Thread | null;
}

interface Inbox {
  id: string;
  name: string;
  source_type: string;
  config?: { events?: string[] };
  webhook_url?: string;
  setup?: Record<string, unknown>;
}

/** The names the steps after the first show. Loaded once per step; anything that fails to load stays null. */
function useFacts(step: number): Facts {
  const [facts, setFacts] = useState<Facts>({ runner: null, bot: null, inbox: null, firstRun: null });
  useEffect(() => {
    let live = true;
    void (async () => {
      const list = async <T,>(path: string) => {
        const r = await lw.api(lw.inOrg(path)).catch(() => null);
        return r?.ok ? (((await r.json().catch(() => null)) as { data?: T[] } | null)?.data ?? []) : [];
      };
      const [runners, bots, inboxes] = await Promise.all([
        list<lw.Runner>("/runners"),
        step >= 1 ? list<lw.Bot>("/bots") : [],
        step >= 1 ? list<Inbox>("/inboxes") : [],
      ]);
      const bot = bots[0] ?? null;
      const inbox = (bot && inboxes.find((i) => bot.inbox_ids.includes(i.id))) ?? inboxes[0] ?? null;
      let firstRun: lw.Thread | null = null;
      if (step >= 3 && bot) {
        const r = await lw.api(`/bots/${bot.id}/threads?status=all`).catch(() => null);
        const threads = r?.ok
          ? (((await r.json().catch(() => null)) as { data?: lw.Thread[] } | null)?.data ?? [])
          : [];
        firstRun = threads.reduce<lw.Thread | null>((a, t) => (!a || t.created_at < a.created_at ? t : a), null);
      }
      if (live) setFacts({ runner: runners.find((r) => r.leased_until) ?? runners[0] ?? null, bot, inbox, firstRun });
    })();
    return () => {
      live = false;
    };
  }, [step]);
  return facts;
}

const time = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

/** Which org the user is in. Null until the orgs have loaded. */
function useOrg() {
  const orgs = useContext(OrgsContext);
  return orgs?.find((o) => o.slug === lw.orgSlug()) ?? null;
}

/**
 * Shown once per org when its three steps are done, in place of the app: every step filled, what the user just did,
 * and a button on to the app. `onContinue` is called once the org has been marked as having seen it.
 */
export function Celebration({ slug, onContinue }: { slug: string; onContinue: () => void }) {
  const me = lw.useMe();
  const facts = useFacts(3);
  const [busy, setBusy] = useState(false);
  const proceed = async () => {
    setBusy(true);
    // If this fails the app still opens; the celebration comes back on the next visit.
    await lw.api("/orgs/" + encodeURIComponent(slug) + "/celebrated", { method: "POST" }).catch(() => null);
    onContinue();
  };
  const rows = [
    ["Runner", facts.runner?.name ?? "", "online", time(facts.runner?.created_at)],
    [
      "Bot",
      facts.bot ? facts.bot.name + (facts.inbox ? ", hears " + facts.inbox.name : "") : "",
      "ready",
      time(facts.bot?.created_at),
    ],
    [
      "First run",
      facts.firstRun ? (facts.firstRun.title ?? facts.firstRun.subjects[0] ?? "") : "",
      "delivered",
      time(facts.firstRun?.created_at),
    ],
  ];
  return (
    <DashLayout title="You did it · loopway" me={me} bleed>
      <div className="zs">
        <SetupSteps progress={{ runner: true, bot: true, ran: true }} />
        <Lede eyebrow={"Set up · " + slug} title="You did it" big>
          A runner, a bot and a first run. loopway is working for you now, and every message after this one takes the
          same path.
        </Lede>
        <section className="zs-section" aria-label="Setup complete">
          <div className="zs-wrap zs-stack">
            <table className="zs-table">
              <thead>
                <tr>
                  <th scope="col">What</th>
                  <th scope="col">Name</th>
                  <th scope="col">State</th>
                  <th scope="col" className="r">
                    Since
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([what, name, state, since]) => (
                  <tr key={what}>
                    <td>{what}</td>
                    <td className="mono">{name}</td>
                    <td className="state">{state}</td>
                    <td className="mono r">{since}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="zs-actions">
              <button className="btn" type="button" disabled={busy} onClick={() => void proceed()}>
                Continue to loopway
              </button>
              <span className="zs-aside">The bot keeps running as long as that terminal stays open.</span>
            </div>
          </div>
        </section>
        <Notes
          label="What people do next"
          notes={[
            {
              title: "A second inbox",
              body: "The same bot can hear from Linear or a schedule as well as GitHub. One prompt, several sources.",
            },
            {
              title: "Keep it running",
              body: "Start the runner on a machine that stays on, or under a process manager, so the bot answers while your laptop is closed.",
            },
            {
              title: "Work with others",
              body: "Make a shared org and add members from the CLI. Its bots and runners show on one page for everyone.",
            },
          ]}
        />
      </div>
    </DashLayout>
  );
}

/** The footnote on step 1 about the kind of org the user is in. */
function OrgNote() {
  const org = useOrg();
  if (!org) return null;
  return org.personal ? (
    <>
      <strong>{org.slug}</strong> is yours alone and has no members, which makes it the simplest place to try things. To
      work with others, make a shared org first with <code>loopway orgs create &lt;slug&gt;</code>; bots and inboxes
      don't move between orgs.
    </>
  ) : (
    <>
      <strong>{org.slug}</strong> is shared: everyone in it sees the same bots, inboxes and runners, and any member's
      runner can pick a bot up.
      <MembersHint />
    </>
  );
}

function StepOne({ org }: { org: string }) {
  const cmds = commands(org);
  const shown = [
    {
      c: cmds[0]!,
      label: "1 · Install",
      why: "Puts the loopway command on this machine. Needs Node 22 or newer.",
      prompt: "$",
    },
    {
      c: cmds[1]!,
      label: "2 · Log in",
      why: "Emails you a one-time code. Paste it back in the terminal.",
      prompt: "$",
    },
    {
      c: cmds[2]!,
      label: "3 · Run",
      why: "Starts the runner. Run it inside the repo your bots should work in, and leave it open.",
      prompt: "~/code/your-repo $",
    },
  ];
  const personal = useOrg()?.personal;
  return (
    <>
      <Lede
        eyebrow="Getting started · the whole idea"
        title="Services send webhooks. loopway hands them to a bot on your machine."
        diagram={[
          { title: "GitHub, Linear, Vercel…", caption: "sends a webhook" },
          { title: "loopway inbox", caption: "keeps the message" },
          { title: "runner on your machine", caption: "step 1 · this page", inked: true },
          { title: "your coding agent", caption: "does the work" },
        ]}
      >
        A bot is a coding agent, Claude Code or Codex say, running where your code and credentials already are. loopway
        keeps an inbox in front of it, and a runner on your machine picks each message up. Three steps, and the first is
        three commands.
      </Lede>
      <section className="zs-section" aria-labelledby="zs-step">
        <div className="zs-wrap zs-stack">
          <div className="zs-heading">
            <p className="zs-eyebrow">Step 1 of 3 · on the machine where your code lives</p>
            <h2 id="zs-step">Start a runner</h2>
            <p className="zs-muted">
              Three commands. The last one stays open: it is the runner, and it waits for messages.
            </p>
          </div>
          <ol className="zs-commands" aria-label="Runner commands">
            {shown.map(({ c, label, why, prompt }) => (
              <li key={c.key}>
                <div className="zs-command-label">
                  <span className="zs-label">{label}</span>
                  <span className="zs-muted small">{why}</span>
                </div>
                <CommandPanel text={c.text} what={c.key as Copied} prompt={prompt} />
              </li>
            ))}
          </ol>
          <div className="zs-actions">
            <CopyButton
              className="zs-ghost-dark"
              what="all"
              text={cmds.map((c) => c.text).join("\n")}
              label="Copy all three"
            />
            <span className="zs-aside">
              Prefer to read first? The <ReadmeLink /> covers the same ground.
            </span>
          </div>
          <Waiting what={"Waiting for a runner on " + org}>
            This page moves on by itself when the runner connects. Nothing to click.
          </Waiting>
        </div>
      </section>
      <Notes
        label="Notes"
        notes={[
          {
            title: personal === false ? "You're in a shared org" : "You're in your personal org",
            body: <OrgNote />,
          },
          {
            title: "Stuck on a command",
            body: (
              <>
                The <ReadmeLink /> walks through each one, and{" "}
                <a href="/llms.txt" target="_blank" rel="noreferrer">
                  llms.txt
                </a>{" "}
                is the same guide written for your agent, so you can hand the whole step to it.
              </>
            ),
          },
        ]}
      />
    </>
  );
}

function StepTwo({ org, facts }: { org: string; facts: Facts }) {
  const prompt = agentPrompt(org, location.origin);
  return (
    <>
      <Lede
        eyebrow={"Step 2 of 3 · runner " + (facts.runner ? facts.runner.name + " " : "") + "is online"}
        title="Your runner is connected. Now give it a bot."
        diagram={[
          { title: "GitHub, Linear, Vercel…", caption: "sends a webhook" },
          { title: "loopway inbox", caption: "step 2 · the bot's inbox", inked: true },
          { title: "runner on your machine", caption: "online", ready: true },
          { title: "your coding agent", caption: "step 2 · the bot's prompt", inked: true },
        ]}
      >
        A bot is an inbox and a prompt: which service it hears from, and what to do when a message arrives. Your own
        coding agent can set one up in a minute, since it already knows how to read a doc and run a CLI.
      </Lede>
      <section className="zs-section" aria-label="Make a bot">
        <div className="zs-wrap zs-stack">
          <div className="zs-columns">
            <div className="zs-col main">
              <div className="zs-heading">
                <p className="zs-eyebrow">With your agent · the quick way</p>
                <h2>Paste this into your agent</h2>
                <p className="zs-muted">
                  Claude Code, Codex or whichever you use. It reads loopway's docs, asks what the bot should do, creates
                  the inbox and the bot in {org}, and hands you the webhook URL to add in that service.
                </p>
              </div>
              <pre className="zs-prompt">{prompt}</pre>
              <div className="zs-actions">
                <CopyButton className="btn btn-md" what="prompt" text={prompt} label="Copy prompt" />
                <span className="zs-aside">
                  Your agent will ask for the one-time code; it goes to the address you logged in with.
                </span>
              </div>
            </div>
            <div className="zs-col side">
              <div className="zs-heading">
                <p className="zs-eyebrow">By hand</p>
                <h3>Or run the CLI yourself</h3>
              </div>
              <dl className="zs-rows">
                <div>
                  <dt>
                    <code>loopway inbox create --org {org}</code>
                  </dt>
                  <dd>
                    Name it, pick the source (GitHub, Linear, Vercel, a schedule…) and keep the secret it prints. It is
                    shown once.
                  </dd>
                </div>
                <div>
                  <dt>
                    <code>loopway bots create --org {org}</code>
                  </dt>
                  <dd>
                    Pick the harness, the model and the inbox, then write the prompt: what the bot does when a message
                    arrives.
                  </dd>
                </div>
                <div>
                  <dt className="zs-label">Nothing to restart</dt>
                  <dd>Your runner picks the new bot up on its next poll.</dd>
                </div>
              </dl>
              <p className="zs-muted small">
                Every flag is in the <ReadmeLink hash="#cli">CLI reference</ReadmeLink>.
              </p>
            </div>
          </div>
          <Waiting what={"Waiting for a bot in " + org}>This page moves on by itself once the bot exists.</Waiting>
        </div>
      </section>
      <Notes
        label="Notes"
        notes={[
          {
            title: "What makes a good first bot",
            body: "Something small that reads one kind of message and writes one thing back: summarize a pull request when it opens, or file a Linear issue from a failed deploy. Bigger jobs come easily once you have seen one run.",
          },
          {
            title: "Where it runs",
            body: "In the directory your runner started in, with the credentials that machine already has. loopway never sees your code; it only passes the message along.",
          },
        ]}
      />
    </>
  );
}

function StepThree({ facts }: { facts: Facts }) {
  const { runner, bot, inbox } = facts;
  const source = inbox ? sourceLabel(inbox.source_type) : "the service";
  const events = inbox?.config?.events;
  const github = inbox?.source_type === "github";
  const sample = github ? "pull_request" : "sample";
  const setup = Object.entries(inbox?.setup ?? {}).filter(([k, v]) => typeof v === "string" && k !== "payload_url");
  return (
    <>
      <Lede
        eyebrow={"Step 3 of 3 · bot " + (bot?.name ?? "") + (inbox ? " hears inbox " + inbox.name : "")}
        title="Your bot is ready. Send it something."
        diagram={[
          { title: source + ", or you", caption: "step 3 · send a message", inked: true },
          { title: "inbox " + (inbox?.name ?? ""), caption: "ready", ready: true },
          { title: "runner " + (runner?.name ?? ""), caption: "online", ready: true },
          { title: "bot " + (bot?.name ?? ""), caption: "ready", ready: true },
        ]}
      >
        The runner starts an agent session the moment a message lands in the bot's inbox. You can wait for {source} to
        send one, or send a test message now and watch the first run in a few seconds.
      </Lede>
      <section className="zs-section" aria-label="Send a message">
        <div className="zs-wrap zs-stack">
          <div className="zs-columns">
            {inbox && (
              <div className="zs-col main test">
                <div className="zs-heading">
                  <p className="zs-eyebrow">The quick way</p>
                  <h2>Send a test message</h2>
                  <p className="zs-muted">
                    loopway posts a sample {sample} event to {inbox.name}, signed the way {source} would sign it. The
                    bot treats it like any other message, and the inbox marks it as a test.
                  </p>
                </div>
                <div className="zs-actions">
                  <TestMessageButton inboxId={inbox.id} from="zero_state" />
                  <span className="zs-aside">About ten seconds to the first run.</span>
                </div>
              </div>
            )}
            <div className={"zs-col " + (inbox ? "side wide" : "full")}>
              <div className="zs-heading">
                <p className="zs-eyebrow">The real thing</p>
                <h2>Add the webhook in {source}</h2>
                {github ? (
                  <p className="zs-muted small">In the repo, under Settings, then Webhooks. Content type is JSON.</p>
                ) : (
                  setup.length === 0 && <p className="zs-muted small">Point {source} at the payload URL below.</p>
                )}
              </div>
              <dl className="zs-rows">
                <div>
                  <dt className="zs-label">Payload URL</dt>
                  <dd>
                    {inbox?.webhook_url ? (
                      <CommandPanel text={inbox.webhook_url} what="webhook_url" />
                    ) : (
                      <span className="zs-muted small">Loading…</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="zs-label">Secret</dt>
                  <dd className="zs-muted small">
                    Shown once when the inbox was made; your agent has it. Lost it? Set a new one with{" "}
                    <code>loopway inbox update {inbox?.name ?? "<inbox>"} --secret</code> and paste the same value in{" "}
                    {source}.
                  </dd>
                </div>
                {events && (
                  <div>
                    <dt className="zs-label">Events</dt>
                    <dd className="zs-muted small">
                      {events.includes("*") ? "Everything " + source + " sends." : events.join(", ") + "."}
                      {github && " Anything else answers 422 and GitHub shows it as a failed delivery."}
                    </dd>
                  </div>
                )}
                {!github &&
                  setup.map(([k, v]) => (
                    <div key={k}>
                      <dt className="zs-label">{k.replace(/_/g, " ")}</dt>
                      <dd className="zs-muted small">{String(v)}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          </div>
          <Waiting what={"Waiting for the first message to " + (bot?.name ?? "your bot")}>
            When it arrives you will see the run here and in the terminal you left open.
          </Waiting>
          <table className="zs-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Inbox</th>
                <th scope="col">Subject</th>
                <th scope="col" className="r">
                  Run
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={4} className="empty">
                  Runs appear here once a message arrives.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <Notes
        label="Notes"
        notes={[
          {
            title: "What a run looks like",
            body: "The runner opens a session with the bot's prompt and the message, in the repo it started in. The transcript stays on your machine; this page shows the thread, who holds it and what was delivered.",
          },
          {
            title: "If nothing happens",
            body: "Check the terminal the runner is in: it logs each message it picks up. A delivery the sender marks as failed usually means the secret differs or the event type is not one the inbox takes.",
          },
        ]}
      />
    </>
  );
}

/** What an org that hasn't finished setting up sees in place of its dashboard: three steps, then the app. */
export function ZeroState({ progress }: { progress: SetupProgress }) {
  const me = lw.useMe();
  useEffect(() => {
    track("zero_state_viewed");
  }, []);
  const current = currentStep(progress);
  const facts = useFacts(current);
  const org = lw.orgSlug();
  return (
    <DashLayout title="Get started · loopway" me={me} bleed>
      <div className="zs">
        <SetupSteps progress={progress} />
        {current === 0 && <StepOne org={org} />}
        {current === 1 && <StepTwo org={org} facts={facts} />}
        {current === 2 && <StepThree facts={facts} />}
      </div>
    </DashLayout>
  );
}
