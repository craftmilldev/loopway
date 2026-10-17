import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Tests that touch the database use the one openTestDb() builds from the migrations. This fails when a test file
// stands up its own store or DB instead, since that schema could drift from what ships.
const packages = join(import.meta.dirname, "../..");

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

const files = readdirSync(packages)
  .filter((pkg) => pkg !== "node_modules")
  .flatMap((pkg) => {
    try {
      return testFiles(join(packages, pkg, "test"));
    } catch {
      return [];
    }
  })
  .filter((f) => f !== import.meta.filename);

const fakes: [RegExp, string][] = [
  [/vi\.mock\([^)]*(store|\/db\b|db\/)/, "mocks the store or db module"],
  [/\bas (unknown as )?Db\b/, "casts something to Db"],
  [/:\s*Db\s*=\s*\{/, "builds a Db object literal"],
  [/\b(fake|mock|stub|inMemory|memory)(Db|Store|Database|Pool)\b/i, "names a fake store or database"],
  [/class\s+\w*(Fake|Mock|InMemory)\w*(Db|Store|Database)\b/, "declares a fake store or database class"],
  [/\bopenDb\(/, "opens a database itself instead of using openTestDb()"],
];

describe("tests use the real database", () => {
  it("finds the test files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => [relative(packages, f), f]))("%s has no DB or store fake", (_name, file) => {
    const src = readFileSync(file!, "utf8");
    const found = fakes.filter(([re]) => re.test(src)).map(([, why]) => why);
    expect(found).toEqual([]);
    // An API under test gets its database from openTestDb() (directly or through helpers.ts).
    if (/\bgetDb\s*:/.test(src)) expect(src).toMatch(/openTestDb|\.\/helpers\.js/);
  });
});
