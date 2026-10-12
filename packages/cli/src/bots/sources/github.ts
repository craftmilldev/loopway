import type { Environment } from "@marcbachmann/cel-js";
import type { BotRule } from "../../client.js";
import type { RuleSource } from "../rules.js";

export const github: RuleSource = {
  prefix: "com.github.",
  extend: (env: Environment) =>
    // github_closes(body): the issue numbers a PR body closes ("Closes #12", "fixes #3"), as a list of strings.
    env.registerFunction("github_closes(dyn): list<string>", (body: unknown) =>
      typeof body === "string"
        ? [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)].map((m) => m[1]!)
        : [],
    ),
};

/** The rules of the `github-threads` bot kind. */
export const GITHUB_THREADS_RULES: BotRule[] = [
  // CI runs belong to the PR they ran for; a run with no PR (on main) belongs to no thread.
  ...(["check_run", "check_suite", "workflow_run"] as const).map((kind) => ({
    types: [`com.github.${kind}.*`],
    subject: `has(data.repository) && has(data.${kind}) && has(data.${kind}.pull_requests) && size(data.${kind}.pull_requests) > 0 ? data.repository.full_name + '#' + string(data.${kind}.pull_requests[0].number) : ''`,
    skip: "subject == ''",
  })),
  // Everything else belongs to its issue or PR, and to the issues a PR body closes. An issue labeled `future` is
  // recorded but not worked on until a message arrives after the label is removed.
  {
    types: ["com.github.*"],
    subject:
      "has(data.repository) && (has(data.pull_request) || has(data.issue) || has(data.number)) ? data.repository.full_name + '#' + string(has(data.pull_request) ? data.pull_request.number : has(data.issue) ? data.issue.number : data.number) : ''",
    related:
      "has(data.repository) && has(data.pull_request) && has(data.pull_request.body) ? github_closes(data.pull_request.body).map(n, data.repository.full_name + '#' + n) : []",
    skip: "!held && has(data.issue) && has(data.issue.labels) && data.issue.labels.exists(l, l.name == 'future')",
  },
];
