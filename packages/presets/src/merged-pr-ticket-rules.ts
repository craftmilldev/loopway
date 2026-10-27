import type { BotRule } from "@loopway/rules";
import { AUTHOR_KIND } from "./github-threads-rules.js";

/** The assign rule of the `merged-pr-ticket` bot: a merged pull request is a thread of its own, and nothing else is. */
export const MERGED_PR_TICKET_RULES: BotRule[] = [
  {
    types: ["com.github.pull_request.closed"],
    subject:
      "has(data.repository) && has(data.pull_request) ? data.repository.full_name + '#' + string(data.pull_request.number) : ''",
    authorKind: AUTHOR_KIND,
    action: "subject != '' && has(data.pull_request.merged) && data.pull_request.merged ? 'attach' : 'skip'",
  },
];
