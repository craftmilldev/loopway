import { defineConfig } from "vitest/config";

// Timestamps print in local time; pin it so the expected lines don't depend on the machine.
process.env.TZ = "UTC";

export default defineConfig({ test: {} });
