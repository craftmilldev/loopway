import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../public/install.sh", import.meta.url));

function write(file: string, body: string, mode = 0o644) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  chmodSync(file, mode);
}

function git(cwd: string, ...args: string[]) {
  const res = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(res.stderr);
}

// Runs install.sh against a local git repo standing in for GitHub, with a fake npm whose global prefix is a temp dir.
// The fake `npm install -g` creates the loopway command unless `link` is false, as the real one sometimes doesn't.
describe("install.sh", () => {
  let dir: string;
  let repo: string;
  let src: string;
  let prefix: string;
  let fakeBin: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "install-sh-"));
    repo = join(dir, "repo");
    src = join(dir, "home", "src");
    prefix = join(dir, "prefix");
    fakeBin = join(dir, "fake-bin");
    write(join(repo, "packages/cli/package.json"), "{}\n");
    write(join(repo, "version.txt"), "1\n");
    git(dir, "init", "-q", "-b", "main", repo);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "first");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function install({ link = true, onPath = true, otherLoopway = false, buildFails = false } = {}) {
    const binDir = join(prefix, "bin");
    write(
      join(fakeBin, "npm"),
      `#!/bin/sh
echo "npm $*" >> "${dir}/npm.log"
case "$1 $2" in
  "prefix -g") echo "${prefix}" ;;
  "run build") ${buildFails ? "exit 1" : ":"} ;;
  "install -g"*) ${link ? `mkdir -p "${binDir}" && printf '#!/bin/sh\\necho 9.9.9\\n' > "${binDir}/loopway" && chmod +x "${binDir}/loopway"` : ":"} ;;
esac
`,
      0o755,
    );
    // Only node from its own directory, which may also hold a real loopway (Homebrew's, say)
    if (!existsSync(join(fakeBin, "node"))) symlinkSync(process.execPath, join(fakeBin, "node"));
    const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    if (!existsSync(join(fakeBin, "git"))) symlinkSync(gitPath, join(fakeBin, "git"));
    const path = [fakeBin, "/usr/bin", "/bin"];
    if (otherLoopway) {
      const other = join(dir, "other-bin");
      write(join(other, "loopway"), "#!/bin/sh\necho 0.0.1\n", 0o755);
      path.unshift(other);
    }
    if (onPath) path.push(binDir);
    return spawnSync("sh", [script], {
      encoding: "utf8",
      env: { PATH: path.join(":"), HOME: join(dir, "home"), LOOPWAY_HOME: src, LOOPWAY_REPO_URL: `file://${repo}` },
    });
  }

  it("clones the repo, builds it and installs the CLI directory globally", () => {
    const res = install();
    expect(res.status).toBe(0);
    expect(readFileSync(join(src, "version.txt"), "utf8")).toBe("1\n");
    const npm = readFileSync(join(dir, "npm.log"), "utf8");
    expect(npm).toContain("npm install --no-audit --no-fund");
    expect(npm).toContain("npm run build");
    expect(npm).toContain(`npm install -g --no-audit --no-fund ${src}/packages/cli`);
    expect(res.stdout).toContain(`Installed loopway from ${src}.`);
    expect(res.stderr).toBe("");
  });

  it("updates an existing clone to the latest main", () => {
    expect(install().status).toBe(0);
    write(join(repo, "version.txt"), "2\n");
    git(repo, "commit", "-qam", "second");
    const res = install();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`Updating ${src}`);
    expect(readFileSync(join(src, "version.txt"), "utf8")).toBe("2\n");
  });

  it("won't touch a directory that isn't a loopway clone", () => {
    write(join(src, "mine.txt"), "keep\n");
    const res = install();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("isn't a loopway clone");
    expect(readFileSync(join(src, "mine.txt"), "utf8")).toBe("keep\n");
  });

  it("fails when the build fails, and doesn't install", () => {
    const res = install({ buildFails: true });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("the build failed");
    expect(readFileSync(join(dir, "npm.log"), "utf8")).not.toContain("install -g");
  });

  it("fails when npm didn't create the command", () => {
    const res = install({ link: false });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`didn't create ${prefix}/bin/loopway`);
    expect(res.stdout).not.toContain("Installed");
  });

  it("warns when the loopway on PATH is another one", () => {
    const res = install({ otherLoopway: true });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("not the");
  });

  it("warns when the install directory isn't on PATH", () => {
    const res = install({ onPath: false });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("isn't on your PATH");
  });
});
