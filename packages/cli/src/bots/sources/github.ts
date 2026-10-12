import type { Environment } from "@marcbachmann/cel-js";
import type { RuleSource } from "../rules.js";

export const github: RuleSource = {
  prefix: "com.github.",
  extend: (env: Environment) =>
    // github_closes(body): the issue numbers a PR body closes ("Closes #12", "fixes #3"), as a list of strings.
    // Text in code blocks, code spans and double quotes is an example, not a reference, so it's skipped.
    env.registerFunction("github_closes(dyn): list<string>", (body: unknown) =>
      typeof body === "string"
        ? [
            ...body
              .replace(/```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"/g, " ")
              .matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi),
          ].map((m) => m[1]!)
        : [],
    ),
};
