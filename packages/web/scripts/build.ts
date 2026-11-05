import { build } from "esbuild";
import { runMigrations } from "../src/db/run-migrations.js";
import { createMetrics } from "../src/metrics.js";
import { clientBuild } from "./client.js";

// Bundle first, then migrate, so everything that can fail cheaply has passed before the database changes. A failing
// migration fails the build, and Vercel keeps the previous deployment live.
await build(clientBuild);
await runMigrations({ metrics: createMetrics() });
