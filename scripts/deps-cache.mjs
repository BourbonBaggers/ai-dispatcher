#!/usr/bin/env node
// A checkout always owns its node_modules. Reflinks share disk blocks when supported;
// ordinary copies preserve isolation on filesystems without copy-on-write support.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const start = Date.now();
const checkout = resolve(process.argv[2] ?? ".");
const repo = process.env.DISPATCHER_REPO ?? "";
const stateDir = process.env.DISPATCHER_STATE_DIR ?? "./state";
const cacheRoot = process.env.DISPATCHER_DEPS_CACHE_DIR || join(stateDir, "deps-cache");
const repoDir = join(cacheRoot, repo.replace("/", "-"));
const nodeModules = join(checkout, "node_modules");
const checkoutKeyFile = join(checkout, ".dispatcher-deps-key");
const lockfile = join(checkout, "package-lock.json");
const schema = join(checkout, "prisma", "schema.prisma");
const limit = 3;

function run(command, args, cwd = checkout) {
  const result = spawnSync(command, args, { cwd, stdio: "pipe", encoding: "utf8", maxBuffer: 10_000_000 });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed: ${(result.stderr || result.error?.message || "exit " + result.status).trim().slice(0, 500)}`);
}

function report(outcome, key, reason = "") {
  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  process.stdout.write(`dependencies ${outcome} key=${key.slice(0, 12)} seconds=${seconds}${reason ? ` reason=${reason.replace(/\s+/g, " ").slice(0, 200)}` : ""}\n`);
}

function installPrivate() {
  rmSync(nodeModules, { recursive: true, force: true });
  run("npm", ["ci"]);
  const pkg = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
  if (Object.hasOwn(pkg.scripts ?? {}, "db:generate")) run("npm", ["run", "db:generate"]);
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function cacheKey() {
  const hash = createHash("sha256");
  hash.update(`node:${process.versions.node.split(".")[0]}\nlock:${digest(lockfile)}\n`);
  if (existsSync(schema)) hash.update(`schema:${digest(schema)}\n`);
  return hash.digest("hex");
}

function valid(entry, key) {
  try {
    const marker = JSON.parse(readFileSync(join(entry, "complete.json"), "utf8"));
    return marker.key === key && statSync(join(entry, "node_modules")).isDirectory();
  } catch { return false; }
}

function linksStayPrivate(root) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const item of readdirSync(current)) {
      const path = join(current, item);
      const info = lstatSync(path);
      if (info.isDirectory()) pending.push(path);
      if (info.isSymbolicLink()) {
        const target = resolve(dirname(path), readlinkSync(path));
        if (!target.startsWith(`${root}${sep}`)) return false;
      }
    }
  }
  return true;
}

function attach(entry) {
  const temp = join(checkout, `.dispatcher-node-modules-${process.pid}`);
  rmSync(temp, { recursive: true, force: true });
  try {
    cpSync(join(entry, "node_modules"), temp, { recursive: true, force: false, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    // cpSync's FICLONE option requests CoW and safely copies when unavailable.
    renameSync(temp, nodeModules);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function prune(current) {
  const entries = readdirSync(repoDir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && valid(join(repoDir, item.name), item.name))
    .map((item) => ({ name: item.name, mtime: statSync(join(repoDir, item.name, "complete.json")).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const item of entries.slice(limit)) {
    if (item.name !== current) rmSync(join(repoDir, item.name), { recursive: true, force: true });
  }
}

function fallback(key, reason) {
  try {
    installPrivate();
    writeFileSync(checkoutKeyFile, key);
    report("fallback", key, reason);
  } catch (error) {
    process.stderr.write(`dependency fallback failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
  process.stderr.write("invalid DISPATCHER_REPO for dependency cache\n");
  process.exit(1);
}
if (!existsSync(join(checkout, "package.json"))) process.exit(0);

let key;
try { key = cacheKey(); }
catch (error) { fallback("no-lock", `cache key unavailable: ${error.message}`); process.exit(); }

const priorKey = existsSync(checkoutKeyFile) ? readFileSync(checkoutKeyFile, "utf8") : "";
if (existsSync(nodeModules)) {
  if (priorKey !== key) {
    fallback(key, priorKey ? "lockfile or schema changed in this checkout" : "existing dependencies have no verified cache key");
  } else {
    report("hit", key, "private checkout dependencies already present");
  }
  process.exit();
}

try {
  mkdirSync(repoDir, { recursive: true });
  if (process.argv[3] !== "--locked") {
    const result = spawnSync("flock", [join(repoDir, ".lock"), process.execPath, process.argv[1], checkout, "--locked"], {
      env: process.env, encoding: "utf8", maxBuffer: 10_000_000,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) throw new Error(`cache lock failed: ${result.error?.message ?? result.status}`);
    process.exit();
  }
  const entry = join(repoDir, key);
  // A killed installer may leave staging data. The lock proves no builder still owns it.
  for (const item of readdirSync(repoDir)) {
    if (item.startsWith(".building-")) rmSync(join(repoDir, item), { recursive: true, force: true });
  }
  if (existsSync(entry) && !valid(entry, key)) rmSync(entry, { recursive: true, force: true });
  if (valid(entry, key)) {
    try {
      attach(entry);
      writeFileSync(checkoutKeyFile, key);
      report("hit", key);
      prune(key);
    } catch (error) { fallback(key, `cache attach failed: ${error.message}`); }
  } else {
    installPrivate();
    writeFileSync(checkoutKeyFile, key);
    try {
      if (!linksStayPrivate(nodeModules)) throw new Error("dependencies contain a link outside node_modules");
      const stage = mkdtempSync(join(repoDir, ".building-"));
      try {
        cpSync(nodeModules, join(stage, "node_modules"), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
        writeFileSync(join(stage, "complete.json"), JSON.stringify({ key, createdAt: new Date().toISOString() }));
        renameSync(stage, entry);
      } finally { rmSync(stage, { recursive: true, force: true }); }
      prune(key);
      report("miss", key);
    } catch (error) { report("fallback", key, `cache publish failed: ${error.message}`); }
  }
} catch (error) {
  fallback(key, `cache unavailable: ${error.message}`);
}
