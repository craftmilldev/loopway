import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file drops and recreates the `loopway` schema on a real Postgres, so run them one at a time there.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
