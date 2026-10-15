// A Claude Code PreToolUse hook that denies the file tools' writes (Edit, Write, ...) outside the allowed roots or
// inside the denied ones, since Claude Code's sandbox only covers commands. Plain JS, run as `node write-guard.mjs`
// with the policy in $LOOPWAY_WRITE_GUARD as JSON `{ roots, deny }` (absolute paths) and the tool call on stdin.
//
// Claude Code only blocks a call when the hook exits 2, so anything unexpected exits 2 too. It resolves symlinks of
// the nearest existing parent so a link can't lead out.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

const within = (target, root) => target === root || target.startsWith(root + sep);
const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

function deny(message) {
  console.error(message);
  process.exit(2);
}

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const policy = JSON.parse(process.env.LOOPWAY_WRITE_GUARD ?? "");
    const roots = policy.roots.map(real);
    const denied = policy.deny.map(real);
    const toolInput = JSON.parse(input).tool_input ?? {};
    const file = toolInput.file_path || toolInput.notebook_path;
    if (typeof file !== "string" || !file) throw new Error("no path");
    let existing = resolve(file);
    let tail = "";
    while (!existsSync(existing) && dirname(existing) !== existing) {
      tail = join(basename(existing), tail);
      existing = dirname(existing);
    }
    const target = join(real(existing), tail);
    if (roots.some((r) => within(target, r)) && !denied.some((d) => within(target, d))) process.exit(0);
    deny(`Writes outside the working directory, git dir, temp and tool caches are not allowed: ${file}`);
  } catch (err) {
    deny(`Write guard could not check this write: ${err.message}`);
  }
});
