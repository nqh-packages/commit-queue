#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.COMMIT_QUEUE_INSTALL_HOME || homedir();
const installRoot = path.join(home, ".commit-queue");
const stateRoot = process.env.COMMIT_QUEUE_STATE_DIR || installRoot;
const hookRepo = path.resolve(process.env.COMMIT_QUEUE_REPO_HOOKS_TARGET || repoRoot);
const binDir = path.join(installRoot, "bin");
const distDir = path.join(installRoot, "dist");
const managedBlock = [
  "# >>> commit-queue >>>",
  "commit_queue_bin=\"$HOME/.commit-queue/bin\"",
  "if [ -d \"$commit_queue_bin\" ]; then",
  "  commit_queue_path=\"$(printf '%s' \"$PATH\" | awk -v bin=\"$commit_queue_bin\" 'BEGIN { RS=\":\" } $0 != bin && $0 != \"\" { parts[++n] = $0 } END { for (i = 1; i <= n; i++) printf \"%s%s\", (i > 1 ? \":\" : \"\"), parts[i] }')\"",
  "  export PATH=\"$commit_queue_bin${commit_queue_path:+:$commit_queue_path}\"",
  "  unset commit_queue_bin commit_queue_path",
  "fi",
  "# <<< commit-queue <<<",
  "",
].join("\n");

ensureBuiltRuntime();
mkdirSync(binDir, { recursive: true });
mkdirSync(distDir, { recursive: true });
installFile(path.join(repoRoot, "bin/git"), path.join(binDir, "git"), 0o755);
installFile(path.join(repoRoot, "bin/hgit"), path.join(binDir, "hgit"), 0o755);
installDirectory(path.join(repoRoot, "dist"), distDir);
rmSync(path.join(installRoot, "src"), { recursive: true, force: true });
writeFileSync(path.join(installRoot, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
ensureShellProfile(path.join(home, ".zprofile"));
ensureShellProfile(path.join(home, ".zshrc"));
ensureShellProfile(path.join(home, ".zshenv"));
ensureShellProfile(path.join(home, ".bash_profile"));
ensureShellProfile(path.join(home, ".bashrc"));
ensureShellProfile(path.join(home, ".profile"));
ensureRepoHooksPath();
clearFailedRefreshMarker(repoRoot);

process.stdout.write([
  "[commit-queue] local install complete",
  "protected git installed",
  "Restart the shell or run: export PATH=\"$HOME/.commit-queue/bin:$PATH\"",
  "",
].join("\n"));

function ensureBuiltRuntime() {
  const result = spawnSync("npm", ["run", "build", "--silent"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

function installFile(source, target, mode) {
  if (!path.resolve(target).startsWith(path.resolve(installRoot))) {
    throw new Error(`Refusing to write outside install root: ${target}`);
  }

  rmSync(target, { force: true });
  copyFileSync(source, target);
  chmodSync(target, mode);
}

function installDirectory(source, target) {
  if (!path.resolve(target).startsWith(path.resolve(installRoot))) {
    throw new Error(`Refusing to write outside install root: ${target}`);
  }

  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

function ensureShellProfile(profilePath) {
  const current = existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";
  const next = replaceManagedBlock(current);
  if (next !== current) {
    writeFileSync(profilePath, next);
  }
}

function replaceManagedBlock(content) {
  const pattern = /# >>> commit-queue >>>[\s\S]*?# <<< commit-queue <<<\n?/;
  if (pattern.test(content)) {
    return content.replace(pattern, managedBlock);
  }
  const separator = content.endsWith("\n") || content.length === 0 ? "" : "\n";
  return `${content}${separator}\n${managedBlock}`;
}

function ensureRepoHooksPath() {
  if (process.env.COMMIT_QUEUE_INSTALL_REPO_HOOKS === "0") return;
  if (!existsSync(path.join(hookRepo, ".git"))) return;

  const hooksDir = path.join(hookRepo, ".githooks");
  if (!existsSync(hooksDir)) {
    throw new Error(`Cannot install commit-queue hooks; missing ${hooksDir}`);
  }

  const result = spawnSync(resolveRealGit(), ["-C", hookRepo, "config", "--local", "core.hooksPath", ".githooks"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

function resolveRealGit() {
  if (process.env.COMMIT_QUEUE_REAL_GIT) return process.env.COMMIT_QUEUE_REAL_GIT;
  for (const candidate of ["/opt/homebrew/bin/git", "/usr/bin/git", "git"]) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  return "git";
}

function clearFailedRefreshMarker(repo) {
  rmSync(path.join(stateRoot, "stale-installs", `${hash(path.resolve(repo))}.json`), { force: true });
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
