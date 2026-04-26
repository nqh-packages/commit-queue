import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const gitShim = path.join(repoRoot, "bin/git");
const hgitShim = path.join(repoRoot, "bin/hgit");

export const realGit = process.env.COMMIT_QUEUE_REAL_GIT || findRealGit();

export function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "commit-queue-test-"));
  const repoPath = path.join(root, "repo");
  const state = path.join(root, "state");

  mkdirSync(repoPath, { recursive: true });
  mkdirSync(state, { recursive: true });
  const repo = realpathSync(repoPath);

  runRealGit(repo, ["init", "-b", "main"]);
  runRealGit(repo, ["config", "user.name", "Commit Queue Test"]);
  runRealGit(repo, ["config", "user.email", "commit-queue@example.test"]);

  writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  runRealGit(repo, ["add", "README.md"]);
  runRealGit(repo, ["commit", "-m", "test: initial"]);

  return {
    root,
    repo,
    state,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function createTempDir() {
  const root = mkdtempSync(path.join(tmpdir(), "commit-queue-test-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function writeRepoFile(repo, relativePath, content) {
  const target = path.join(repo, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

export function runCommitQueue(repo, args, options = {}) {
  return runNode(gitShim, repo, args, options);
}

export function runHgit(repo, args, options = {}) {
  return runNode(hgitShim, repo, args, options);
}

export function runRealGit(repo, args, options = {}) {
  return runCommand(realGit, args, {
    cwd: repo,
    env: options.env,
    allowFailure: options.allowFailure,
  });
}

export function activateSession(repo, state, agentEnv = defaultAgentEnv()) {
  const result = runCommitQueue(repo, ["getID"], { state, env: agentEnv });
  assert.equal(result.status, 0, result.stderr);

  const exports = {};
  for (const line of result.stdout.trim().split("\n")) {
    const match = line.match(/^export (COMMIT_QUEUE_[A-Z_]+)="([^"]*)"$/);
    if (match) {
      exports[match[1]] = match[2];
    }
  }

  assert.match(exports.COMMIT_QUEUE_ID, /^cq_/);
  assert.equal(exports.COMMIT_QUEUE_REPO, repo);
  return exports;
}

export function defaultAgentEnv() {
  return {
    COMMIT_QUEUE_AGENT: "codex",
    COMMIT_QUEUE_AGENT_SESSION: "codex-test-session",
  };
}

export function sessionIndexPath(state, sessionId) {
  return path.join(state, "indexes", `${sessionId}.index`);
}

export function runRealGitWithIndex(repo, indexPath, args) {
  return runRealGit(repo, args, {
    env: { GIT_INDEX_FILE: indexPath },
  });
}

function runNode(script, cwd, args, options = {}) {
  return runCommand(process.execPath, [script, ...args], {
    cwd,
    env: {
      COMMIT_QUEUE_STATE_DIR: options.state,
      COMMIT_QUEUE_REAL_GIT: realGit,
      ...options.env,
    },
    allowFailure: options.allowFailure ?? true,
  });
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: "utf8",
  });

  if (!options.allowFailure && result.status !== 0) {
    assert.fail(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        `status: ${result.status}`,
        `stdout: ${result.stdout}`,
        `stderr: ${result.stderr}`,
      ].join("\n"),
    );
  }

  return result;
}

function findRealGit() {
  for (const candidate of ["/opt/homebrew/bin/git", "/usr/bin/git"]) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) {
      return candidate;
    }
  }
  return "git";
}
