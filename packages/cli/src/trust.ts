import type { Bot } from "./bots.js";
import type { Trust } from "./rules.js";
import type { SubjectSource } from "./source.js";

/**
 * Who each bot trusts: its `trusted` list with every team turned into its members, plus you and the bot user. A team
 * that can't be read throws, so loopway doesn't run with a smaller list than the one written down.
 */
export async function resolveTrust(
  bots: Bot[],
  source: Pick<SubjectSource, "teamMembers">,
  owner: string,
  botUser?: string,
): Promise<Trust & { everyone: string[] }> {
  const teams = new Map<string, string[]>();
  for (const team of new Set(bots.flatMap((b) => b.trusted).filter((t) => t.includes("/")))) {
    try {
      if (!source.teamMembers) throw new Error("this source can't list teams");
      teams.set(team, await source.teamMembers(team));
    } catch (err) {
      throw new Error(
        `Can't read the team ${team} (${(err as Error).message}). loopway won't run with a trusted list it can't resolve: ` +
          "check the team's name and that your gh token can read org members (read:org).",
        { cause: err },
      );
    }
  }
  const lower = (logins: string[]) => logins.map((l) => l.toLowerCase());
  const always = lower([owner, ...(botUser ? [botUser] : [])]);
  const byBot = new Map(
    bots.map((b) => [b.name, new Set([...always, ...lower(b.trusted.flatMap((t) => teams.get(t) ?? [t]))])]),
  );
  return {
    owner,
    botUser: botUser && botUser.toLowerCase() !== owner.toLowerCase() ? botUser : undefined,
    trusts: (bot, login) => byBot.get(bot)?.has(login.toLowerCase()) ?? false,
    everyone: [...new Set([...byBot.values()].flatMap((s) => [...s]))],
  };
}
