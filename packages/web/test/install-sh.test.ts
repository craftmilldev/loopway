import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../content/install.sh", import.meta.url));

function writeScript(file: string, body: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

// Runs install.sh against a local release with a fake npm whose global prefix is a temp dir. The fake `npm install -g`
// creates the loopway command unless `link` is false, as the real one sometimes doesn't.
describe("install.sh", () => {
  let dir: string;
  let prefix: string;
  let fakeBin: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "install-sh-"));
    prefix = join(dir, "prefix");
    fakeBin = join(dir, "fake-bin");
    mkdirSync(fakeBin);
    const release = join(dir, "release");
    mkdirSync(release);
    writeFileSync(join(release, "manifest.txt"), "loopway-cli.tgz\n");
    writeFileSync(join(release, "loopway-cli.tgz"), "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // `layout` is where npm puts global commands: prefix/bin, Volta's shim directory, or the prefix itself (Windows).
  function install({ link = true, onPath = true, otherLoopway = false, layout = "unix" } = {}) {
    const volta = join(dir, "volta");
    const binDir = layout === "volta" ? join(volta, "bin") : layout === "windows" ? prefix : join(prefix, "bin");
    writeScript(
      join(layout === "volta" ? binDir : fakeBin, "npm"),
      `case "$1 $2" in
  "prefix -g") echo "${prefix}" ;;
  "install -g") ${link ? `mkdir -p "${binDir}" && printf '#!/bin/sh\\necho 9.9.9\\n' > "${binDir}/loopway" && chmod +x "${binDir}/loopway"` : ":"} ;;
esac`,
    );
    if (layout === "windows") writeScript(join(fakeBin, "uname"), "echo MINGW64_NT-10.0-19045");
    // Only node from its own directory, which may also hold a real loopway (Homebrew's, say)
    symlinkSync(process.execPath, join(fakeBin, "node"));
    const path = [fakeBin, "/usr/bin", "/bin"];
    if (otherLoopway) {
      const other = join(dir, "other-bin");
      writeScript(join(other, "loopway"), "echo 0.0.1");
      path.unshift(other);
    }
    if (onPath) path.push(binDir);
    const env: Record<string, string> = {
      PATH: path.join(":"),
      HOME: dir,
      LOOPWAY_DOWNLOAD_URL: `file://${join(dir, "release")}`,
    };
    if (layout === "volta") env.VOLTA_HOME = volta;
    return spawnSync("sh", [script], { encoding: "utf8", env });
  }

  it("reports the installed version when it's the loopway on PATH", () => {
    const res = install();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Installed loopway 9.9.9.");
    expect(res.stderr).toBe("");
  });

  it("fails when npm didn't create the command", () => {
    const res = install({ link: false });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`didn't create ${prefix}/bin/loopway`);
    expect(res.stderr).toContain("npm rebuild -g @loopway/cli");
    expect(res.stdout).not.toContain("Installed");
  });

  it("runs the installed file and warns about another loopway earlier on PATH", () => {
    const res = install({ otherLoopway: true });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Installed loopway 9.9.9.");
    expect(res.stderr).toContain(`the loopway on your PATH is ${join(dir, "other-bin", "loopway")}`);
  });

  it("finds the command where Volta puts it", () => {
    const res = install({ layout: "volta" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Installed loopway 9.9.9.");
    expect(res.stderr).toBe("");
  });

  it("finds the command in the prefix itself on Windows", () => {
    const res = install({ layout: "windows" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Installed loopway 9.9.9.");
    expect(res.stderr).toBe("");
  });

  it("warns when npm's bin directory isn't on PATH", () => {
    const res = install({ onPath: false });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Installed loopway 9.9.9.");
    expect(res.stderr).toContain(`${prefix}/bin isn't on your PATH`);
  });
});
