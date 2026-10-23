import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AgentPrompt } from "./agent-prompt.js";
import { commands, CopyCommand } from "./runners.js";
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

/** The three step circles: done ones filled, the first one not done highlighted. */
function SetupSteps({ progress }: { progress: SetupProgress }) {
  const current = currentStep(progress);
  const done = [progress.runner, progress.bot, progress.ran];
  return (
    <ol className="setup-steps" aria-label="Setup progress">
      {STEPS.map((label, i) => (
        <li key={label} className={done[i] ? "done" : undefined} aria-current={i === current ? "step" : undefined}>
          <span className="setup-circle" aria-label={done[i] ? "Done" : undefined}>
            {done[i] ? "✓" : i + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

/**
 * Shown once per org when its three steps are done, in place of the app: every step filled, what the user just did,
 * and a button on to the app. `onContinue` is called once the org has been marked as having seen it.
 */
export function Celebration({ slug, onContinue }: { slug: string; onContinue: () => void }) {
  const me = lw.useMe();
  const [busy, setBusy] = useState(false);
  const proceed = async () => {
    setBusy(true);
    // If this fails the app still opens; the celebration comes back on the next visit.
    await lw.api("/orgs/" + encodeURIComponent(slug) + "/celebrated", { method: "POST" }).catch(() => null);
    onContinue();
  };
  return (
    <DashLayout title="You did it · loopway" me={me}>
      <SetupSteps progress={{ runner: true, bot: true, ran: true }} />
      <section className="celebration" aria-label="Setup complete">
        <p className="celebration-mark" aria-hidden="true">
          ✓
        </p>
        <h1>You did it</h1>
        <p className="muted">
          You connected a runner, made your first bot and watched it handle its first message. loopway is working for
          you now.
        </p>
        <button className="btn btn-md" type="button" disabled={busy} onClick={() => void proceed()}>
          Continue to loopway
        </button>
      </section>
    </DashLayout>
  );
}

/** Which org the user is in, and what the other kind would give them. Nothing until the orgs have loaded. */
function OrgExplainer() {
  const orgs = useContext(OrgsContext);
  const org = orgs?.find((o) => o.slug === lw.orgSlug());
  if (!org) return null;
  return (
    <section className="org-explainer" aria-label="About orgs">
      <span className="lbl">{org.personal ? "You're in your personal org" : "You're in a shared org"}</span>
      <p className="muted">
        An org holds bots, inboxes and runners.{" "}
        {org.personal ? (
          <>
            <strong>{org.slug}</strong> is your personal org: it's yours alone and can't have other members, which makes
            it the simplest place to start and to try things. If you'll work with others, make a shared org with{" "}
            <code>loopway orgs create &lt;slug&gt;</code>; bots and inboxes don't move between orgs, so it's easiest to
            decide before you build.
          </>
        ) : (
          <>
            <strong>{org.slug}</strong> is a shared org: everyone in it sees the same bots, inboxes and runners, and any
            member's runner can pick a bot up. Your personal org is separate and stays yours alone. Use a shared org for
            team work, and your personal one for anything private.
          </>
        )}
      </p>
    </section>
  );
}

/** What an org that hasn't finished setting up sees in place of its dashboard: three steps, then the app. */
export function ZeroState({ progress }: { progress: SetupProgress }) {
  const me = lw.useMe();
  useEffect(() => {
    track("zero_state_viewed");
  }, []);
  const current = currentStep(progress);
  // Step 3 needs an inbox to poke: the first one the org's first bot reads.
  const bots = lw.useList<lw.Bot>(lw.inOrg("/bots"), !!me && current === 2);
  const testInbox = bots.data?.find((b) => b.inbox_ids.length)?.inbox_ids[0];
  return (
    <DashLayout title="Get started · loopway" me={me}>
      <SetupSteps progress={progress} />
      {current === 0 && (
        <>
          <div className="page-head">
            <h1>Get your runner going and we'll make some bots together</h1>
          </div>
          <section className="runner-setup" aria-label="Start a runner">
            <p className="muted">
              loopway catches webhooks from services like GitHub and Linear and hands them to a bot. A bot is a coding
              agent (Claude Code, Codex and so on) that runs on <em>your</em> machine, so your code and credentials stay
              there. The three commands below set that machine up: the first installs the <code>loopway</code> command,
              the second logs you in with an emailed code, and the third starts a <em>runner</em> in your repo. The
              runner waits for messages and starts an agent session for each one. It doesn't connect any agent to
              loopway until you make a bot, which is the next step. Leave the last command open.
            </p>
            {commands(lw.orgSlug()).map((c) => (
              <CopyCommand key={c.key} command={c} from="zero_state" />
            ))}
            <p className="muted">
              Prefer to read first? The{" "}
              <a
                href="https://github.com/craftmilldev/loopway#readme"
                target="_blank"
                rel="noreferrer"
                onClick={() => track("zero_state_readme_clicked")}
              >
                README
              </a>{" "}
              covers the same ground.
            </p>
          </section>
          <OrgExplainer />
          <AgentPrompt from="zero_state" />
        </>
      )}
      {current === 1 && (
        <>
          <div className="page-head">
            <h1>Your runner is connected</h1>
          </div>
          <p className="muted">
            Your machine is now ready to run agents for loopway. Next you make a <em>bot</em> and the inbox it listens
            to. An <em>inbox</em> is a webhook address for one service, like GitHub or Linear; loopway keeps every
            message sent to it. The bot reads one or more inboxes and has a prompt that tells its agent what to do with
            each message. Your runner then starts an agent session on this machine whenever a message arrives. The
            easiest way to set all that up is to hand the prompt below to the coding agent you already use: it asks what
            you want the bot to do, creates the inbox and bot, and gives you the webhook URL and secret to paste into
            the service. Nothing is sent to your agent until a message arrives.
          </p>
          <AgentPrompt from="zero_state" />
        </>
      )}
      {current === 2 && (
        <>
          <div className="page-head">
            <h1>Your bot is ready</h1>
          </div>
          <p className="muted">
            Now give it something to do. Add the webhook URL and secret your agent gave you (or run{" "}
            <code>loopway inbox show &lt;inbox&gt;</code> to see them again) in the service the inbox listens to, then
            do what that service sends events for, such as opening a pull request on GitHub or commenting on a Linear
            issue. The message lands in the inbox, your runner starts an agent session for it, and this page moves on
            when the bot has handled its first message. If nothing happens, check that your runner is still open with{" "}
            <code>loopway runners</code>. Don't want to set up the sender yet? Send the inbox a test message instead.
          </p>
          {testInbox && <TestMessageButton inboxId={testInbox} from="zero_state" />}
        </>
      )}
      <p className="muted" style={{ marginTop: 24 }}>
        <MembersHint />
      </p>
    </DashLayout>
  );
}
