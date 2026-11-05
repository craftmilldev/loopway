import { defineConfig } from "vitest/config";

// These tests run the API in-process on a database of their own, alongside the web package's in CI.
export default defineConfig({ test: { testTimeout: 20_000, hookTimeout: 30_000 } });
