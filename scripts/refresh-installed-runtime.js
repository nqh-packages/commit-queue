#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const hookName = hookArg();
const realGit = process.env.COMMIT_QUEUE_REAL_GIT || "/usr/bin/git";
const repo = resolveRepo();
const head = git(["rev-parse", "--verify", "HEAD"]).stdout.trim();
const installHome = process.env.COMMIT_QUEUE_INSTALL_HOME || homedir();
const installRoot = path.join(installHome, ".commit-queue");
const markerPath = failedInstallRefreshPath(repo);

try {
  refreshFromHead();
  clearFailedMarker();
  process.stdout.write(`[commit-queue] installed runtime refreshed from ${head.slice(0, 12)} (${hookName})\n`);
} catch (error) {
  recordFailedMarker(error);
  process.stderr.write([
    `[commit-queue] installed runtime refresh failed (${hookName})`,
    error instanceof Error ? error.message : String(error),
    `stale marker: ${markerPath}`,
    "",
  ].join("\n"));
  process.exit(1);
}

function refreshFromHead() {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), "commit-queue-refresh-"));
  try {
    const archive = git(["archive", "--format=tar", "HEAD"], { encoding: "buffer" });
    const unpack = spawnSync("tar", ["-x", "-C", sourceRoot], {
      input: archive.stdout,
      encoding: "utf8",
    });
    assertSuccess(unpack, "unpack committed HEAD");

    linkNodeModules(sourceRoot);
    runNpmBuild(sourceRoot);
    installBuiltRuntime(sourceRoot);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

function linkNodeModules(sourceRoot) {
  const repoNodeModules = path.join(repo, "node_modules");
  if (existsSync(repoNodeModules)) {
    symlinkSync(repoNodeModules, path.join(sourceRoot, "node_modules"), "dir");
    return;
  }

  const install = spawnSync("npm", ["ci", "--ignore-scripts"], {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  assertSuccess(install, "install build dependencies");
}

function runNpmBuild(sourceRoot) {
  const build = spawnSync("npm", ["run", "build", "--silent"], {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  assertSuccess(build, "build committed runtime");
}

function installBuiltRuntime(sourceRoot) {
  const binDir = path.join(installRoot, "bin");
  const distDir = path.join(installRoot, "dist");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  installFile(path.join(sourceRoot, "bin/git"), path.join(binDir, "git"), 0o755);
  installFile(path.join(sourceRoot, "bin/hgit"), path.join(binDir, "hgit"), 0o755);
  installDirectory(path.join(sourceRoot, "dist"), distDir);
  rmSync(path.join(installRoot, "src"), { recursive: true, force: true });
  writeFileSync(path.join(installRoot, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
}

function installFile(source, target, mode) {
  assertInsideInstallRoot(target);
  rmSync(target, { force: true });
  copyFileSync(source, target);
  chmodSync(target, mode);
}

function installDirectory(source, target) {
  assertInsideInstallRoot(target);
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

function assertInsideInstallRoot(target) {
  if (!path.resolve(target).startsWith(path.resolve(installRoot))) {
    throw new Error(`Refusing to write outside install root: ${target}`);
  }
}

function clearFailedMarker() {
  rmSync(markerPath, { force: true });
}

function recordFailedMarker(error) {
  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify({
    repo,
    head,
    hook: hookName,
    failedAt: new Date().toISOString(),
    reason: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
}

function resolveRepo() {
  const result = git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  return path.resolve(result.stdout.trim());
}

function git(args, options = {}) {
  const result = spawnSync(realGit, args, {
    cwd: options.cwd || repo,
    encoding: options.encoding || "utf8",
  });
  assertSuccess(result, `git ${args.join(" ")}`);
  return result;
}

function assertSuccess(result, action) {
  if (result.status === 0) return;

  throw new Error([
    `${action} failed`,
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : "",
  ].filter(Boolean).join("\n"));
}

function failedInstallRefreshPath(repoPath) {
  return path.join(stateRoot(), "stale-installs", `${hash(path.resolve(repoPath))}.json`);
}

function stateRoot() {
  return process.env.COMMIT_QUEUE_STATE_DIR || path.join(installHome, ".commit-queue");
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function hookArg() {
  const index = process.argv.indexOf("--hook");
  if (index === -1) return "manual";
  return process.argv[index + 1] || "unknown";
}
