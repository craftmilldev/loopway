import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// The client bundle loads markdown and SVG as plain text (scripts/client.ts); tests do the same.
export default defineConfig({
  // A test that opens its own database runs every migration, alongside every other test file doing the same.
  test: { testTimeout: 20_000, hookTimeout: 30_000 },
  plugins: [
    {
      name: "text-assets",
      transform(_code: string, id: string) {
        if (id.endsWith(".md") || id.endsWith(".svg"))
          return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
      },
    },
  ],
});
