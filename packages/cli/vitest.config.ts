import { defineConfig } from "vitest/config";

// Timestamps print in local time; pin it so the expected lines don't depend on the machine.
process.env.TZ = "UTC";
// Ink only colors and dims when the terminal can; the TUI tests look for dim rows.
process.env.FORCE_COLOR = "1";

export default defineConfig({ test: {} });
