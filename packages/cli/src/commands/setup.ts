import { setTimeout as sleep } from "node:timers/promises";
import { REPLY_TYPE } from "@loopway/rules";
import { authedClient, UsageError, type Context } from "../context.js";
import { json } from "../format.js";
import { resolveOrg } from "./orgs.js";

export interface SetupAskOptions {
  org?: string;
  harness: string;
  /** Seconds to wait for the reply. */
  timeout?: number;
  /** Milliseconds between looks for it. */
  interval?: number;
  json?: boolean;
}

/**
 * `loopway setup ask <message>`: sends the message to the org's hidden setup bot (making it on `--harness` first) and
 * prints its reply. The bot answers from a runner of the org, so one has to be running (`loopway bots run`).
 */
export async function setupAsk(ctx: Context, text: string, opts: SetupAskOptions) {
  const client = await authedClient(ctx);
  const org = await resolveOrg(ctx, client, opts.org, "bot");
  const bot = await client.putSetupBot(org, opts.harness);
  const sent = await client.sendSetupMessage(org, text);
  void ctx.metrics?.capture("setup_ask_sent", { harness: bot.harness });
  const deadline = Date.now() + (opts.timeout ?? 300) * 1000;
  // Message ids are time-ordered, so what comes after the one just sent is the answer to it or to a later one.
  while (Date.now() < deadline) {
    const { data } = await client.listMessages(bot.inbox_id, { type: REPLY_TYPE, cursor: sent.id, limit: 1 });
    const reply = data[0];
    if (reply) {
      const answer = (reply.event.data as { text?: string } | undefined)?.text ?? "";
      void ctx.metrics?.capture("setup_ask_replied", { harness: bot.harness });
      return ctx.out(opts.json ? json({ reply: answer }) : answer);
    }
    await sleep(opts.interval ?? 2000);
  }
  void ctx.metrics?.capture("setup_ask_timed_out", { harness: bot.harness });
  throw new UsageError(
    "The setup bot hasn't replied yet. It answers from a runner of this org: is `loopway bots run` running?",
  );
}
