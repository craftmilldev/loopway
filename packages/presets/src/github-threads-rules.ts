import type { BotRule } from "@loopway/rules";

/** Who made a message: a GitHub app (type Bot, or a login ending in [bot]) or a machine user named `-bot` is a bot. */
export const AUTHOR_KIND =
  "has(data.sender) && has(data.sender.login) ? ((has(data.sender.type) && data.sender.type == 'Bot') || data.sender.login.endsWith('[bot]') || data.sender.login.endsWith('-bot') ? 'bot' : 'human') : ''";

/** The assign rules of the default `github-threads` bot. They use the helpers of the GitHub source. */
export const GITHUB_THREADS_RULES: BotRule[] = [
  // CI runs belong to the PR they ran for. A run with no PR (on main) belongs to no thread: it skips this rule, and
  // the next one skips it too.
  ...(["check_run", "check_suite", "workflow_run"] as const).map((kind) => ({
    types: [`com.github.${kind}.*`],
    subject: `has(data.repository) && has(data.${kind}) && has(data.${kind}.pull_requests) && size(data.${kind}.pull_requests) > 0 ? data.repository.full_name + '#' + string(data.${kind}.pull_requests[0].number) : ''`,
    authorKind: AUTHOR_KIND,
    action: "subject == '' ? 'skip' : 'attach'",
  })),
  // Everything else belongs to its issue or PR, and to the issues a PR body closes. An issue labeled `future` is
  // recorded but not worked on until a message arrives after the label is removed.
  {
    types: ["com.github.*"],
    subject:
      "has(data.repository) && (has(data.pull_request) || has(data.issue) || has(data.number)) ? data.repository.full_name + '#' + string(has(data.pull_request) ? data.pull_request.number : has(data.issue) ? data.issue.number : data.number) : ''",
    related:
      "has(data.repository) && has(data.pull_request) && has(data.pull_request.body) ? regex_all(data.pull_request.body, '(?<![\"\\'`])\\\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\\\s+#(\\\\d+)\\\\b', 'i').map(n, data.repository.full_name + '#' + n) : []",
    authorKind: AUTHOR_KIND,
    action:
      "has(data.check_run) || has(data.check_suite) || has(data.workflow_run) || (!held && has(data.issue) && has(data.issue.labels) && data.issue.labels.exists(l, l.name == 'future')) ? 'skip' : 'attach'",
  },
];
