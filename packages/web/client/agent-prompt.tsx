import { useState } from "react";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

/** The prompt a user gives their own coding agent to make a bot in `org` through the loopway CLI. */
export function agentPrompt(org: string, origin: string) {
  return `Set up a loopway bot for me in my loopway org "${org}".

First read ${origin}/llms.txt: it explains loopway and its CLI.

1. If \`loopway\` isn't installed, install it (needs Node 22+). Run \`loopway login\`; it emails me a one-time code, so ask me for it.
2. Ask me what I want the bot to do and which service it should hear from. Then create the inbox and the bot with \`--org ${org}\`, and tell me the webhook URL and secret to add in that service.
3. Check \`loopway runners\`. A runner already online for this org picks the new bot up by itself; if there is none, start one with \`loopway bots run --org ${org}\` in the directory the bot should work in, and leave it running.`;
}

/** "Create your bot with your agent": the copy-paste prompt, shown where a user makes their first bot. */
export function AgentPrompt({ from }: { from: string }) {
  const [copied, setCopied] = useState(false);
  const text = agentPrompt(lw.orgSlug(), location.origin);
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
