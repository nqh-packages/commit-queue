import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  activateSession,
  createFixture,
  createTempDir,
  runCommitQueue,
  runHgit,
  runRealGit,
  runRealGitWithIndex,
  sessionIndexPath,
  writeRepoFile,
} from "./helpers/git-fixture.js";

test("read-only commands pass through without a session", () => {
  const fixture = createFixture();
  try {
    const status = runCommitQueue(fixture.repo, ["status", "--short"], { state: fixture.state });
    const log = runCommitQueue(fixture.repo, ["log", "-1", "--pretty=%s"], { state: fixture.state });
    const branch = runCommitQueue(fixture.repo, ["branch", "--show-current"], { state: fixture.state });

    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout.trim(), "");
    assert.equal(log.stdout.trim(), "test: initial");
    assert.equal(branch.stdout.trim(), "main");
  } finally {
    fixture.cleanup();
  }
});

test("empty git invocation passes through to real Git", () => {
  const fixture = createFixture();
  try {
    const result = runCommitQueue(fixture.repo, [], { state: fixture.state });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /usage: git/i);
  } finally {
    fixture.cleanup();
  }
});

test("outside Git repos, normal Git commands pass through and getID is blocked", () => {
  const temp = createTempDir();
  try {
    const version = runCommitQueue(temp.root, ["--version"], { state: path.join(temp.root, "state") });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /git version/);

    const getId = runCommitQueue(temp.root, ["getID"], { state: path.join(temp.root, "state") });
    assert.notEqual(getId.status, 0);
    assert.match(getId.stderr, /COMMIT_QUEUE_NOT_IN_REPO/);
  } finally {
    temp.cleanup();
  }
});

test("git getID creates a shell-activatable session", () => {
  const fixture = createFixture();
  try {
    const result = runCommitQueue(fixture.repo, ["getID"], { state: fixture.state });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /export COMMIT_QUEUE_ID="cq_/);
    assert.match(result.stdout, /export COMMIT_QUEUE_REPO="/);

    const env = activateSession(fixture.repo, fixture.state);
    const sessionPath = path.join(fixture.state, "sessions", `${env.COMMIT_QUEUE_ID}.json`);
    assert.equal(existsSync(sessionPath), true);

    const session = JSON.parse(readFileSync(sessionPath, "utf8"));
    assert.equal(session.repo, fixture.repo);
    assert.equal(session.id, env.COMMIT_QUEUE_ID);
    assert.match(session.head, /^[0-9a-f]{40}$/);
  } finally {
    fixture.cleanup();
  }
});

test("mutating commands are blocked without a session", () => {
  const fixture = createFixture();
  try {
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");

    const result = runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_SESSION_REQUIRED/);
    assert.doesNotMatch(result.stderr, /hgit/);
  } finally {
    fixture.cleanup();
  }
});

test("mutating commands are protected when repo is selected with global Git options", () => {
  const fixture = createFixture();
  const outside = createTempDir();
  try {
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    writeRepoFile(fixture.repo, "src/b.ts", "export const b = 1;\n");

    const fromDashC = runCommitQueue(outside.root, ["-C", fixture.repo, "add", "src/a.ts"], {
      state: fixture.state,
    });
    const fromGitDir = runCommitQueue(outside.root, [
      `--git-dir=${path.join(fixture.repo, ".git")}`,
      `--work-tree=${fixture.repo}`,
      "add",
      "src/b.ts",
    ], {
      state: fixture.state,
    });

    assert.notEqual(fromDashC.status, 0);
    assert.match(fromDashC.stderr, /COMMIT_QUEUE_SESSION_REQUIRED/);
    assert.notEqual(fromGitDir.status, 0);
    assert.match(fromGitDir.stderr, /COMMIT_QUEUE_SESSION_REQUIRED/);
    assert.equal(runRealGit(fixture.repo, ["diff", "--cached", "--name-only"]).stdout.trim(), "");
  } finally {
    fixture.cleanup();
    outside.cleanup();
  }
});

test("JSON error mode returns structured agent-recoverable errors", () => {
  const fixture = createFixture();
  try {
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");

    const result = runCommitQueue(fixture.repo, ["add", "src/a.ts"], {
      state: fixture.state,
      env: { COMMIT_QUEUE_JSON: "1" },
    });

    assert.notEqual(result.status, 0);
    const error = JSON.parse(result.stderr);
    assert.equal(error.error_code, "COMMIT_QUEUE_SESSION_REQUIRED");
    assert.equal(error.retriable, true);
    assert.equal(error.context.command, "add");
    assert.match(error.suggestions.join("\n"), /git getID/);
    assert.doesNotMatch(JSON.stringify(error), /hgit/);
  } finally {
    fixture.cleanup();
  }
});

test("broad add commands are blocked even with a session", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");

    for (const args of [["add", "."], ["add", "-A"], ["add", "-u"], ["add", ":(glob)**"]]) {
      const result = runCommitQueue(fixture.repo, args, {
        state: fixture.state,
        env,
      });

      assert.notEqual(result.status, 0, `${args.join(" ")} should fail`);
      assert.match(result.stderr, /COMMIT_QUEUE_BROAD_ADD_BLOCKED/);
    }

    assert.equal(
      runRealGitWithIndex(
        fixture.repo,
        sessionIndexPath(fixture.state, env.COMMIT_QUEUE_ID),
        ["diff", "--cached", "--name-only"],
      ).stdout.trim(),
      "",
    );
  } finally {
    fixture.cleanup();
  }
});

test("add with no explicit paths is blocked", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    const result = runCommitQueue(fixture.repo, ["add"], {
      state: fixture.state,
      env,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_EXPLICIT_PATH_REQUIRED/);
  } finally {
    fixture.cleanup();
  }
});

test("blocked shared-tree and history commands fail before Git mutates", () => {
  const fixture = createFixture();
  try {
    const commands = [
      [["checkout", "-b", "other"], "COMMIT_QUEUE_SHARED_TREE_MUTATION_BLOCKED"],
      [["merge", "main"], "COMMIT_QUEUE_HISTORY_MUTATION_BLOCKED"],
      [["stash"], "COMMIT_QUEUE_SHARED_TREE_MUTATION_BLOCKED"],
    ];

    for (const [args, code] of commands) {
      const result = runCommitQueue(fixture.repo, args, { state: fixture.state });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(code));
    }
  } finally {
    fixture.cleanup();
  }
});

test("unsupported mutating commands require a session", () => {
  const fixture = createFixture();
  try {
    const result = runCommitQueue(fixture.repo, ["tag", "v1.0.0"], { state: fixture.state });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_SESSION_REQUIRED/);
  } finally {
    fixture.cleanup();
  }
});

test("unsupported mutating commands are blocked with a session", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    const result = runCommitQueue(fixture.repo, ["tag", "v1.0.0"], {
      state: fixture.state,
      env,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_UNSUPPORTED_MUTATION_BLOCKED/);
  } finally {
    fixture.cleanup();
  }
});

test("explicit add uses the session index and leaves the shared index clean", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");

    const result = runCommitQueue(fixture.repo, ["add", "src/a.ts"], {
      state: fixture.state,
      env,
    });

    assert.equal(result.status, 0, result.stderr);

    const sharedIndex = runRealGit(fixture.repo, ["diff", "--cached", "--name-only"]);
    assert.equal(sharedIndex.stdout.trim(), "");

    const privateIndex = runRealGitWithIndex(
      fixture.repo,
      sessionIndexPath(fixture.state, env.COMMIT_QUEUE_ID),
      ["diff", "--cached", "--name-only"],
    );
    assert.equal(privateIndex.stdout.trim(), "src/a.ts");
  } finally {
    fixture.cleanup();
  }
});

test("real Git add failures are surfaced", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    const result = runCommitQueue(fixture.repo, ["add", "missing.ts"], {
      state: fixture.state,
      env,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pathspec|did not match any files/);
  } finally {
    fixture.cleanup();
  }
});

test("clean session commit creates a real commit without polluting the shared index", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");

    assert.equal(
      runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status,
      0,
    );

    const commit = runCommitQueue(fixture.repo, ["commit", "-m", "test: add a"], {
      state: fixture.state,
      env,
    });

    assert.equal(commit.status, 0, commit.stderr);
    assert.equal(runRealGit(fixture.repo, ["log", "-1", "--pretty=%s"]).stdout.trim(), "test: add a");
    assert.equal(runRealGit(fixture.repo, ["status", "--short"]).stdout.trim(), "");
    assert.deepEqual(readdirSync(path.join(fixture.state, "locks")), []);
  } finally {
    fixture.cleanup();
  }
});

test("commit -a is blocked with a session", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    const result = runCommitQueue(fixture.repo, ["commit", "-a", "-m", "test: all"], {
      state: fixture.state,
      env,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_COMMIT_ALL_BLOCKED/);
  } finally {
    fixture.cleanup();
  }
});

test("commit --no-verify is blocked with a session", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status, 0);

    for (const args of [
      ["commit", "--no-verify", "-m", "test: skip hooks"],
      ["commit", "-n", "-m", "test: skip hooks"],
    ]) {
      const result = runCommitQueue(fixture.repo, args, {
        state: fixture.state,
        env,
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /COMMIT_QUEUE_NO_VERIFY_BLOCKED/);
      assert.match(result.stderr, /fix the failing check/);
      assert.match(result.stderr, /false positive/);
    }

    assert.equal(runRealGit(fixture.repo, ["log", "-1", "--pretty=%s"]).stdout.trim(), "test: initial");
  } finally {
    fixture.cleanup();
  }
});

test("commit with no staged paths is blocked", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    const result = runCommitQueue(fixture.repo, ["commit", "-m", "test: empty"], {
      state: fixture.state,
      env,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_NOTHING_STAGED/);
  } finally {
    fixture.cleanup();
  }
});

test("commit blocks when session manifest and private index disagree", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status, 0);

    const sessionPath = path.join(fixture.state, "sessions", `${env.COMMIT_QUEUE_ID}.json`);
    const session = JSON.parse(readFileSync(sessionPath, "utf8"));
    session.stagedPaths = {};
    writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);

    const result = runCommitQueue(fixture.repo, ["commit", "-m", "test: mismatch"], {
      state: fixture.state,
      env,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_STAGED_PATH_MISMATCH/);
  } finally {
    fixture.cleanup();
  }
});

test("commit blocks when session metadata points at another session index", () => {
  const fixture = createFixture();
  try {
    const firstEnv = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env: firstEnv }).status, 0);

    const secondEnv = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/b.ts", "export const b = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/b.ts"], { state: fixture.state, env: secondEnv }).status, 0);

    const firstSessionPath = path.join(fixture.state, "sessions", `${firstEnv.COMMIT_QUEUE_ID}.json`);
    const secondSessionPath = path.join(fixture.state, "sessions", `${secondEnv.COMMIT_QUEUE_ID}.json`);
    const firstSession = JSON.parse(readFileSync(firstSessionPath, "utf8"));
    const secondSession = JSON.parse(readFileSync(secondSessionPath, "utf8"));
    firstSession.indexPath = secondSession.indexPath;
    firstSession.stagedPaths = secondSession.stagedPaths;
    writeFileSync(firstSessionPath, `${JSON.stringify(firstSession, null, 2)}\n`);

    const result = runCommitQueue(fixture.repo, ["commit", "-m", "test: hijack"], {
      state: fixture.state,
      env: firstEnv,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_SESSION_TAMPERED/);
    assert.equal(runRealGit(fixture.repo, ["log", "-1", "--pretty=%s"]).stdout.trim(), "test: initial");
  } finally {
    fixture.cleanup();
  }
});

test("commit surfaces real Git commit failures", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status, 0);

    const result = runCommitQueue(fixture.repo, ["commit"], {
      state: fixture.state,
      env: { ...env, GIT_EDITOR: "false" },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Aborting commit|Terminal is dumb|editor/);
  } finally {
    fixture.cleanup();
  }
});

test("commit blocks when a staged file drifts after add", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status, 0);

    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 2;\n");

    const commit = runCommitQueue(fixture.repo, ["commit", "-m", "test: add a"], {
      state: fixture.state,
      env,
    });

    assert.notEqual(commit.status, 0);
    assert.match(commit.stderr, /COMMIT_QUEUE_FILE_DRIFT/);
    assert.equal(runRealGit(fixture.repo, ["log", "-1", "--pretty=%s"]).stdout.trim(), "test: initial");
    assert.deepEqual(readdirSync(path.join(fixture.state, "locks")), []);
  } finally {
    fixture.cleanup();
  }
});

test("commit recovers an orphaned repo lock without manual deletion", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status, 0);

    const lockPath = repoLockPath(fixture.state, fixture.repo);
    mkdirSync(lockPath, { recursive: true });
    const oldEnoughToBeOrphaned = new Date(Date.now() - 10_000);
    utimesSync(lockPath, oldEnoughToBeOrphaned, oldEnoughToBeOrphaned);

    const commit = runCommitQueue(fixture.repo, ["commit", "-m", "test: add a"], {
      state: fixture.state,
      env,
    });

    assert.equal(commit.status, 0, commit.stderr);
    assert.equal(runRealGit(fixture.repo, ["log", "-1", "--pretty=%s"]).stdout.trim(), "test: add a");
    assert.deepEqual(readdirSync(path.join(fixture.state, "locks")), []);
  } finally {
    fixture.cleanup();
  }
});

test("commit recovers a lock whose owner process is gone", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status, 0);

    const lockPath = repoLockPath(fixture.state, fixture.repo);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: 99999999,
      repo: fixture.repo,
      startedAt: new Date().toISOString(),
    }));

    const commit = runCommitQueue(fixture.repo, ["commit", "-m", "test: add a"], {
      state: fixture.state,
      env,
    });

    assert.equal(commit.status, 0, commit.stderr);
    assert.equal(runRealGit(fixture.repo, ["log", "-1", "--pretty=%s"]).stdout.trim(), "test: add a");
    assert.deepEqual(readdirSync(path.join(fixture.state, "locks")), []);
  } finally {
    fixture.cleanup();
  }
});

test("commit lock timeout reports the active owner instead of requiring manual deletion", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status, 0);

    const lockPath = repoLockPath(fixture.state, fixture.repo);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      repo: fixture.repo,
      startedAt: new Date().toISOString(),
    }));

    const commit = runCommitQueue(fixture.repo, ["commit", "-m", "test: add a"], {
      state: fixture.state,
      env: { ...env, COMMIT_QUEUE_LOCK_TIMEOUT_MS: "50" },
    });

    assert.notEqual(commit.status, 0);
    assert.match(commit.stderr, /COMMIT_QUEUE_REPO_LOCK_TIMEOUT/);
    assert.match(commit.stderr, new RegExp(`Active lock owner pid: ${process.pid}`));
    assert.match(commit.stderr, /Lock age: \d+ms/);
    assert.equal(runRealGit(fixture.repo, ["log", "-1", "--pretty=%s"]).stdout.trim(), "test: initial");
  } finally {
    fixture.cleanup();
  }
});

test("commit blocks when HEAD moved after session creation", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status, 0);

    writeRepoFile(fixture.repo, "src/b.ts", "export const b = 1;\n");
    runRealGit(fixture.repo, ["add", "src/b.ts"]);
    runRealGit(fixture.repo, ["commit", "-m", "test: move head"]);

    const commit = runCommitQueue(fixture.repo, ["commit", "-m", "test: add a"], {
      state: fixture.state,
      env,
    });

    assert.notEqual(commit.status, 0);
    assert.match(commit.stderr, /COMMIT_QUEUE_HEAD_DRIFT/);
  } finally {
    fixture.cleanup();
  }
});

test("missing and mismatched sessions are blocked", () => {
  const first = createFixture();
  const second = createFixture();
  try {
    const missing = runCommitQueue(first.repo, ["add", "README.md"], {
      state: first.state,
      env: { COMMIT_QUEUE_ID: "cq_missing" },
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /COMMIT_QUEUE_SESSION_NOT_FOUND/);

    const env = activateSession(first.repo, first.state);
    const mismatch = runCommitQueue(second.repo, ["add", "README.md"], {
      state: first.state,
      env,
    });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /COMMIT_QUEUE_REPO_MISMATCH/);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("repo opt-out passes through to real Git", () => {
  const fixture = createFixture();
  try {
    writeFileSync(path.join(fixture.repo, ".commit-queue.json"), '{ "enabled": false }\n');
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");

    const result = runCommitQueue(fixture.repo, ["add", "."], { state: fixture.state });

    assert.equal(result.status, 0, result.stderr);
    assert.match(runRealGit(fixture.repo, ["diff", "--cached", "--name-only"]).stdout, /src\/a\.ts/);
  } finally {
    fixture.cleanup();
  }
});

test("invalid opt-out config fails open to protected mode", () => {
  const fixture = createFixture();
  try {
    writeFileSync(path.join(fixture.repo, ".commit-queue.json"), "{ nope\n");
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");

    const result = runCommitQueue(fixture.repo, ["add", "."], { state: fixture.state });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_SESSION_REQUIRED|COMMIT_QUEUE_BROAD_ADD_BLOCKED/);
  } finally {
    fixture.cleanup();
  }
});

test("COMMIT_QUEUE_BYPASS is ignored by protected git", () => {
  const fixture = createFixture();
  try {
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");

    const result = runCommitQueue(fixture.repo, ["add", "."], {
      state: fixture.state,
      env: { COMMIT_QUEUE_BYPASS: "1" },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_SESSION_REQUIRED|COMMIT_QUEUE_BROAD_ADD_BLOCKED/);
    assert.equal(runRealGit(fixture.repo, ["diff", "--cached", "--name-only"]).stdout.trim(), "");
  } finally {
    fixture.cleanup();
  }
});

test("hgit passes through to real Git", () => {
  const fixture = createFixture();
  try {
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");

    const result = runHgit(fixture.repo, ["add", "."], { state: fixture.state });

    assert.equal(result.status, 0, result.stderr);
    assert.match(runRealGit(fixture.repo, ["diff", "--cached", "--name-only"]).stdout, /src\/a\.ts/);
  } finally {
    fixture.cleanup();
  }
});

function repoLockPath(state, repo) {
  const lockName = createHash("sha256").update(repo).digest("hex").slice(0, 24);
  return path.join(state, "locks", `${lockName}.lock`);
}
