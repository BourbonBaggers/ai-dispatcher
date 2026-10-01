import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const helper = new URL("../scripts/deps-cache.mjs", import.meta.url).pathname;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dispatch-deps-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "npm-calls");
  writeFileSync(join(bin, "npm"), `#!/bin/sh\nset -eu\nprintf '%s\\n' "$*" >> "$FAKE_NPM_CALLS"\nif [ "$1" = ci ]; then mkdir -p node_modules; printf original > node_modules/value; fi\nif [ "$1" = run ]; then printf generated > node_modules/generated; fi\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_NPM_CALLS: calls, DISPATCHER_REPO: "acme/widgets", DISPATCHER_STATE_DIR: join(root, "state") };
  const checkout = (name: string, lock = "same", schema?: string) => {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { "db:generate": "fake" } }));
    writeFileSync(join(path, "package-lock.json"), lock);
    if (schema) {
      mkdirSync(join(path, "prisma"));
      writeFileSync(join(path, "prisma", "schema.prisma"), schema);
    }
    return path;
  };
  const run = (path: string) => new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, [helper, path], { env });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
  });
  return { root, calls, checkout, run, entries: () => readdirSync(join(root, "state", "deps-cache", "acme-widgets")).filter((name) => /^[a-f0-9]{64}$/.test(name)), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("miss installs once, hit skips npm and attaches private files", async () => {
  const f = fixture();
  try {
    const first = f.checkout("first");
    const second = f.checkout("second");
    assert.match((await f.run(first)).output, /dependencies miss key=/);
    assert.match((await f.run(second)).output, /dependencies hit key=/);
    assert.deepEqual(readFileSync(f.calls, "utf8").trim().split("\n"), ["ci", "run db:generate"]);
    writeFileSync(join(second, "node_modules", "value"), "changed");
    assert.equal(readFileSync(join(first, "node_modules", "value"), "utf8"), "original");
    const key = f.entries()[0]!;
    assert.equal(readFileSync(join(f.root, "state", "deps-cache", "acme-widgets", key, "node_modules", "value"), "utf8"), "original");
  } finally { f.cleanup(); }
});

test("relative links in cached modules stay inside the attached checkout", async () => {
  const f = fixture();
  try {
    const first = f.checkout("first");
    await f.run(first);
    const key = f.entries()[0]!;
    symlinkSync("value", join(f.root, "state", "deps-cache", "acme-widgets", key, "node_modules", "alias"));
    const second = f.checkout("second");
    await f.run(second);
    writeFileSync(join(second, "node_modules", "value"), "private");
    assert.equal(readFileSync(join(second, "node_modules", "alias"), "utf8"), "private");
    assert.equal(readFileSync(join(f.root, "state", "deps-cache", "acme-widgets", key, "node_modules", "alias"), "utf8"), "original");
  } finally { f.cleanup(); }
});

test("corrupt entry is rebuilt, and a changed lock or schema gets a new key", async () => {
  const f = fixture();
  try {
    await f.run(f.checkout("first", "same", "schema-a"));
    const key = f.entries()[0]!;
    rmSync(join(f.root, "state", "deps-cache", "acme-widgets", key, "complete.json"));
    assert.match((await f.run(f.checkout("second", "same", "schema-a"))).output, /dependencies miss/);
    assert.match((await f.run(f.checkout("third", "new", "schema-a"))).output, /dependencies miss/);
    assert.match((await f.run(f.checkout("fourth", "same", "schema-b"))).output, /dependencies miss/);
    assert.equal(f.entries().length, 3);
  } finally { f.cleanup(); }
});

test("concurrent misses install once", async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.run(f.checkout("a")), f.run(f.checkout("b"))]);
    assert.equal(a.code, 0, a.output);
    assert.equal(b.code, 0, b.output);
    assert.equal((readFileSync(f.calls, "utf8").match(/^ci$/gm) ?? []).length, 1);
  } finally { f.cleanup(); }
});

test("changed lockfile in a checkout triggers private install without changing cache", async () => {
  const f = fixture();
  try {
    const path = f.checkout("first");
    await f.run(path);
    const key = f.entries()[0]!;
    writeFileSync(join(path, "package-lock.json"), "changed");
    writeFileSync(join(path, "node_modules", "value"), "agent edit");
    assert.match((await f.run(path)).output, /dependencies fallback.*lockfile or schema changed/);
    assert.equal(readFileSync(join(f.root, "state", "deps-cache", "acme-widgets", key, "node_modules", "value"), "utf8"), "original");
    assert.equal((readFileSync(f.calls, "utf8").match(/^ci$/gm) ?? []).length, 2);
  } finally { f.cleanup(); }
});

test("pruning keeps the newest three complete entries", async () => {
  const f = fixture();
  try {
    await f.run(f.checkout("run-0", "lock-0"));
    const staging = join(f.root, "state", "deps-cache", "acme-widgets", ".building-abandoned");
    mkdirSync(staging);
    for (let n = 1; n < 5; n++) await f.run(f.checkout(`run-${n}`, `lock-${n}`));
    assert.equal(f.entries().length, 3);
    assert.equal(readdirSync(join(f.root, "state", "deps-cache", "acme-widgets")).includes(".building-abandoned"), false);
  } finally { f.cleanup(); }
});
