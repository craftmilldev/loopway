import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** A directory is a project when it has a `.loopway/` folder, unless that folder is loopway's own home (`~/.loopway`). */
const isProject = (dir: string, home: string) =>
  join(dir, ".loopway") !== resolve(home) &&
  (statSync(join(dir, ".loopway"), { throwIfNoEntry: false })?.isDirectory() ?? false);

/**
 * The project directory, the one holding `.loopway/`. `--project <dir>` names it; without that it is the nearest
 * directory at or above `from` that has a `.loopway/` folder, the way git finds a repo. It needs no `.git`. The
 * `~/.loopway` folder (`home`) holds config and state, so it never makes `~` a project.
 */
export function findProject(from: string, home: string, explicit?: string): string {
  if (explicit !== undefined) {
    const dir = resolve(from, explicit);
    if (isProject(dir, home)) return dir;
    throw new Error(`No .loopway/ folder in ${dir} (from --project).`);
  }
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (isProject(dir, home)) return dir;
    if (dirname(dir) === dir) break;
  }
  throw new Error(
    `No .loopway/ folder in ${resolve(from)} or any directory above it. Run loopway inside a project, or name one with --project <dir>.`,
  );
}
