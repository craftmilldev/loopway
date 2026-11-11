import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const hasLoopway = (dir: string) => statSync(join(dir, ".loopway"), { throwIfNoEntry: false })?.isDirectory() ?? false;

/**
 * The project directory, the one holding `.loopway/`. `--project <dir>` names it; without that it is the nearest
 * directory at or above `from` that has a `.loopway/` folder, the way git finds a repo.
 */
export function findProject(from: string, explicit?: string): string {
  if (explicit !== undefined) {
    const dir = resolve(from, explicit);
    if (hasLoopway(dir)) return dir;
    throw new Error(`No .loopway/ folder in ${dir} (from --project).`);
  }
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (hasLoopway(dir)) return dir;
    if (dirname(dir) === dir) break;
  }
  throw new Error(
    `No .loopway/ folder in ${resolve(from)} or any directory above it. Run loopway inside a project, or name one with --project <dir>.`,
  );
}
