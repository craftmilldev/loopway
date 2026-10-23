import { useState } from "react";
import * as lw from "./lw.js";
import { track } from "./metrics.js";
import type { SetupProgress } from "./zero-state.js";

/**
 * The prompt a user gives their own coding agent to make a bot in `org` through the loopway CLI. With a runner online
 * and no bot yet (step 2 of the zero state) the user has installed, logged in and started a runner already, so the
 * prompt skips those and goes straight to the bot.
 */
export function agentPrompt(org: string, origin: string, progress?: SetupProgress) {
  const intro = `Set up a loopway bot for me in my loopway org "${org}".

First read ${origin}/llms.txt: it explains loopway and its CLI.`;
  if (progress?.runner && !progress.bot) {
    return `${intro}

I'm already logged in to org "${org}" and have a runner online for it. Check with \`loopway login\` status and \`loopway runners\`, and only fix it if it's wrong.

1. Ask me what I want the bot to do and which service it should hear from.
2. Create the inbox and the bot with \`--org ${org}\`, and tell me the inbox name and the webhook URL to add in that service. Don't repeat the secret back to me; I'll get it myself with \`loopway inbox update <inbox> --secret\` or on the inbox page in the web app. The runner picks the new bot up by itself.`;
  }
  return `${intro}

1. If \`loopway\` isn't installed, install it (needs Node 22+). Run \`loopway login\`; it emails me a one-time code, so ask me for it.
2. Ask me what I want the bot to do and which service it should hear from. Then create the inbox and the bot with \`--org ${org}\`, and tell me the inbox name and the webhook URL to add in that service. Don't repeat the secret back to me; I'll get it myself with \`loopway inbox update <inbox> --secret\` or on the inbox page in the web app.
3. Check \`loopway runners\`. A runner already online for this org picks the new bot up by itself; if there is none, start one with \`loopway bots run --org ${org}\` in the directory the bot should work in, and leave it running.`;
}

/** "Create your bot with your agent": the copy-paste prompt, shown where a user makes their first bot. The text shown is the text copied. */
export function AgentPrompt({ from, progress }: { from: string; progress?: SetupProgress }) {
  const [copied, setCopied] = useState(false);
  const text = agentPrompt(lw.orgSlug(), location.origin, progress);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return track("agent_prompt_copy_failed", { from });
    }
    track("agent_prompt_copied", { from });
    setCopied(true);
  };
  return (
    <section className="agent-prompt" aria-label="Create your bot with your agent">
      <span className="lbl">Create your bot with your agent</span>
      <p className="muted">
        Give this to Claude Code, Codex or whichever agent you use. It makes the bot and starts it.
      </p>
      <pre>{text}</pre>
      <button className="btn btn-sm btn-quiet" type="button" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy prompt"}
      </button>
    </section>
  );
}
