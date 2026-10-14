import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// The client bundle loads markdown as plain text (scripts/client.ts); tests do the same.
export default defineConfig({
  plugins: [
    {
      name: "markdown-as-text",
      transform(_code: string, id: string) {
        if (id.endsWith(".md")) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
      },
    },
  ],
});
