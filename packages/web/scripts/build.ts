import { build } from "esbuild";
import { clientBuild } from "./client.js";

await build(clientBuild);
