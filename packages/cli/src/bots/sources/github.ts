import type { Environment } from "@marcbachmann/cel-js";
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
