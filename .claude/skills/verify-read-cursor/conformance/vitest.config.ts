import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

// Separate from packages/web's config so this suite runs only when this skill runs it.
export default defineConfig({
  test: { root: here, include: ["*.test.ts"], testTimeout: 20000 },
  resolve: { alias: { "@web": resolve(here, "../../../../packages/web/src") } },
});
