// @craftmilldev/analytics is private (GitHub Packages), but the CLI is installed by people without a token, so
// the published CLI carries it inline: this inlines it into dist/metrics.js after tsc. posthog-node stays a regular
// dependency of the CLI, and the CLI's own modules stay separate files.
import { build } from "esbuild";

await build({
  entryPoints: ["dist/metrics.js"],
  outfile: "dist/metrics.js",
  allowOverwrite: true,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["node:*", "posthog-node"],
  plugins: [
    {
      name: "keep-cli-modules",
      setup(b) {
        // A relative import from the CLI's own files (not from the package's) is left alone.
        b.onResolve({ filter: /^\.\.?\// }, (args) =>
          args.kind === "entry-point" || args.importer.includes("node_modules")
            ? undefined
            : { path: args.path, external: true },
        );
      },
    },
  ],
});
