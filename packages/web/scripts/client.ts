import type { BuildOptions } from "esbuild";

// Bundles the React web UI (client/) into public/app.js and public/app.css. Used by scripts/build.ts and
// scripts/dev.ts.
export const clientBuild: BuildOptions = {
  entryPoints: { app: "client/main.tsx" },
  outdir: "public",
  bundle: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  loader: { ".md": "text" },
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  sourcemap: true,
  logLevel: "info",
};
