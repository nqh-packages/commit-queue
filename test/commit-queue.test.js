import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
    const lsFiles = runCommitQueue(fixture.repo, ["ls-files", "README.md"], { state: fixture.state });
    const config = runCommitQueue(fixture.repo, ["config", "--get", "user.email"], { state: fixture.state });

    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout.trim(), "");
    assert.equal(log.stdout.trim(), "test: initial");
    assert.equal(branch.stdout.trim(), "main");
    assert.equal(lsFiles.stdout.trim(), "README.md");
    assert.equal(config.stdout.trim(), "commit-queue@example.test");
  } finally {
    fixture.cleanup();
  }
});

test("safe rev-parse inspection passes through without a session", () => {
  const fixture = createFixture();
  try {
    const result = runCommitQueue(fixture.repo, ["rev-parse", "--show-toplevel"], { state: fixture.state });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), fixture.repo);
  } finally {
    fixture.cleanup();
  }
});

test("outside Git repos, getID is blocked", () => {
  const temp = createTempDir();
  try {
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
    const result = runCommitQueue(fixture.repo, ["getID"], {
      state: fixture.state,
      env: { CODEX_THREAD_ID: "019da855-918f-7880-a76d-8f1937136f86" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /export COMMIT_QUEUE_ID="cq_/);
    assert.match(result.stdout, /export COMMIT_QUEUE_REPO="/);
    assert.match(result.stdout, /export COMMIT_QUEUE_AGENT="codex"/);
    assert.match(result.stdout, /export COMMIT_QUEUE_AGENT_SESSION="codex-019da855-918f-7880-a76d-8f1937136f86"/);

    const id = result.stdout.match(/export COMMIT_QUEUE_ID="([^"]+)"/)?.[1];
    assert.match(id, /^cq_/);

    const sessionPath = path.join(fixture.state, "sessions", `${id}.json`);
    assert.equal(existsSync(sessionPath), true);

    const session = JSON.parse(readFileSync(sessionPath, "utf8"));
    assert.equal(session.repo, fixture.repo);
    assert.equal(session.id, id);
    assert.match(session.head, /^[0-9a-f]{40}$/);
    assert.deepEqual(session.agent, {
      name: "codex",
      sessionId: "codex-019da855-918f-7880-a76d-8f1937136f86",
      detectedFrom: "CODEX_THREAD_ID",
    });
  } finally {
    fixture.cleanup();
  }
});

test("git getID requires a coding agent identity", () => {
  const fixture = createFixture();
  try {
    const result = runCommitQueue(fixture.repo, ["getID"], {
      state: fixture.state,
      env: {
        CODEX_THREAD_ID: "",
        COMMIT_QUEUE_AGENT: "",
        COMMIT_QUEUE_AGENT_SESSION: "",
        OPENCODE_SESSION_ID: "",
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_AGENT_ID_REQUIRED/);
    assert.match(result.stderr, /Protected commit-queue sessions require a coding agent identity/);
    assert.match(result.stderr, /"supported_agents": \[/);
    assert.match(result.stderr, /"codex"/);
    assert.match(result.stderr, /"opencode"/);
    assert.doesNotMatch(result.stderr, /hgit/);
  } finally {
    fixture.cleanup();
  }
});

test("git getID explains why explicit agent session alone is not enough", () => {
  const fixture = createFixture();
  try {
    const result = runCommitQueue(fixture.repo, ["getID"], {
      state: fixture.state,
      env: {
        CODEX_THREAD_ID: "",
        COMMIT_QUEUE_AGENT: "",
        COMMIT_QUEUE_AGENT_SESSION: "custom-session",
        OPENCODE_SESSION_ID: "",
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_AGENT_SESSION alone is not enough/);
    assert.match(result.stderr, /COMMIT_QUEUE_AGENT/);
    assert.match(result.stderr, /"missing_env": \[/);
    assert.match(result.stderr, /"COMMIT_QUEUE_AGENT"/);
    assert.match(result.stderr, /export COMMIT_QUEUE_AGENT=/);
    assert.match(result.stderr, /Example unsupported agent/);
    assert.match(result.stderr, /COMMIT_QUEUE_AGENT="claude-code"/);
    assert.match(result.stderr, /Example Codex/);
    assert.match(result.stderr, /CODEX_THREAD_ID/);
    assert.match(result.stderr, /Example OpenCode/);
    assert.match(result.stderr, /OPENCODE_SESSION_ID/);
    assert.doesNotMatch(result.stderr, /hgit/);
  } finally {
    fixture.cleanup();
  }
});

test("JSON agent identity errors include recovery examples", () => {
  const fixture = createFixture();
  try {
    const result = runCommitQueue(fixture.repo, ["getID"], {
      state: fixture.state,
      env: {
        CODEX_THREAD_ID: "",
        COMMIT_QUEUE_AGENT: "",
        COMMIT_QUEUE_AGENT_SESSION: "custom-session",
        COMMIT_QUEUE_JSON: "1",
        OPENCODE_SESSION_ID: "",
      },
    });

    assert.notEqual(result.status, 0);
    const error = JSON.parse(result.stderr);
    assert.equal(error.error_code, "COMMIT_QUEUE_AGENT_ID_REQUIRED");
    assert.equal(error.context.reason, "explicit_agent_identity_incomplete");
    assert.deepEqual(error.context.missing_env, ["COMMIT_QUEUE_AGENT"]);
    assert.deepEqual(error.context.examples.map((example) => example.label), [
      "unsupported agent",
      "Codex",
      "OpenCode",
    ]);
    assert.match(error.suggestions.join("\n"), /Example unsupported agent/);
  } finally {
    fixture.cleanup();
  }
});

test("protected commands explain why a session is required", () => {
  const fixture = createFixture();
  try {
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");

    const result = runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_SESSION_REQUIRED/);
    assert.match(result.stderr, /sharing this checkout with other agents/);
    assert.match(result.stderr, /eval "\$\(git getID\)"/);
    assert.match(result.stderr, /context:/);
    assert.match(result.stderr, /"command": "add"/);
    assert.match(result.stderr, /retriable: true/);
    assert.doesNotMatch(result.stderr, /hgit/);
  } finally {
    fixture.cleanup();
  }
});

test("protected mutations are blocked while installed runtime refresh marker exists", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    const markerDir = path.join(fixture.state, "stale-installs");
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(path.join(markerDir, `${createHash("sha256").update(fixture.repo).digest("hex").slice(0, 24)}.json`), JSON.stringify({
      repo: fixture.repo,
      head: "abc123",
      hook: "post-commit",
      failedAt: "2026-04-20T00:00:00.000Z",
      reason: "build failed",
    }));

    const result = runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_INSTALL_REFRESH_FAILED/);
    assert.match(result.stderr, /runtime refresh failed/);
    assert.equal(runRealGit(fixture.repo, ["diff", "--cached", "--name-only"]).stdout.trim(), "");
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
    assert.match(error.detail, /sharing this checkout with other agents/);
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
    writeRepoFile(fixture.repo, "src/b.ts", "export const b = 1;\n");

    for (const args of [
      ["add", "."],
      ["add", "-A"],
      ["add", "-u"],
      ["add", ":(glob)**"],
      ["add", "--pathspec-from-file", "paths.txt"],
      ["add", "src"],
      ["add", "src/*.ts"],
      ["add", "src/[ab].ts"],
    ]) {
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

test("unowned Git commands pass through without a session", () => {
  const fixture = createFixture();
  try {
    const tag = runCommitQueue(fixture.repo, ["tag", "v1.0.0"], { state: fixture.state });
    const branch = runCommitQueue(fixture.repo, ["branch", "new-branch"], { state: fixture.state });
    const config = runCommitQueue(fixture.repo, ["config", "alias.co", "checkout"], { state: fixture.state });

    assert.equal(tag.status, 0, tag.stderr);
    assert.equal(branch.status, 0, branch.stderr);
    assert.equal(config.status, 0, config.stderr);
    assert.equal(runRealGit(fixture.repo, ["tag", "--list", "v1.0.0"]).stdout.trim(), "v1.0.0");
    assert.equal(runRealGit(fixture.repo, ["branch", "--list", "new-branch"]).stdout.trim(), "new-branch");
    assert.equal(runRealGit(fixture.repo, ["config", "--get", "alias.co"]).stdout.trim(), "checkout");
  } finally {
    fixture.cleanup();
  }
});

test("clone passes through from inside a protected repo, including harmless inline config", () => {
  const fixture = createFixture();
  try {
    const cloneTarget = path.join(fixture.root, "clone-target");
    const ghStyleCloneTarget = path.join(fixture.root, "gh-style-clone-target");
    const clone = runCommitQueue(fixture.repo, ["clone", "--depth=1", fixture.repo, cloneTarget], {
      state: fixture.state,
    });
    const ghStyleClone = runCommitQueue(fixture.repo, [
      "-c",
      "protocol.version=2",
      "clone",
      "--depth=1",
      fixture.repo,
      ghStyleCloneTarget,
    ], { state: fixture.state });

    assert.equal(clone.status, 0, clone.stderr);
    assert.equal(ghStyleClone.status, 0, ghStyleClone.stderr);
    assert.equal(existsSync(path.join(cloneTarget, ".git")), true);
    assert.equal(existsSync(path.join(ghStyleCloneTarget, ".git")), true);
  } finally {
    fixture.cleanup();
  }
});

test("push passes through without a session", () => {
  const fixture = createFixture();
  const remote = createTempDir();
  try {
    assert.equal(runRealGit(remote.root, ["init", "--bare"]).status, 0);
    assert.equal(runRealGit(fixture.repo, ["remote", "add", "origin", remote.root]).status, 0);

    const result = runCommitQueue(fixture.repo, ["push", "origin", "main"], { state: fixture.state });

    assert.equal(result.status, 0, result.stderr);
    assert.match(runRealGit(remote.root, ["rev-parse", "--verify", "main"]).stdout.trim(), /^[0-9a-f]{40}$/);
  } finally {
    fixture.cleanup();
    remote.cleanup();
  }
});

test("unowned Git commands pass through with a session", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    const result = runCommitQueue(fixture.repo, ["tag", "v1.0.0"], {
      state: fixture.state,
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(runRealGit(fixture.repo, ["tag", "--list", "v1.0.0"], { env }).stdout.trim(), "v1.0.0");
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

test("explicit add from a subdirectory resolves paths like real Git", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    const appDir = path.join(fixture.repo, "apps/booknow");
    writeRepoFile(fixture.repo, "apps/booknow/Sources/Screens/BookingDetailScreen.swift", "struct Screen {}\n");

    const result = runCommitQueue(appDir, ["add", "Sources/Screens/BookingDetailScreen.swift"], {
      state: fixture.state,
      env,
    });

    assert.equal(result.status, 0, result.stderr);

    const privateIndex = runRealGitWithIndex(
      fixture.repo,
      sessionIndexPath(fixture.state, env.COMMIT_QUEUE_ID),
      ["diff", "--cached", "--name-only"],
    );
    assert.equal(privateIndex.stdout.trim(), "apps/booknow/Sources/Screens/BookingDetailScreen.swift");
  } finally {
    fixture.cleanup();
  }
});

test("explicit add accepts literal bracketed route segments", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    const routeFile = "apps/ngoquochuy/src/pages/[locale]/index.astro";
    const escapedRoutePathspec = "apps/ngoquochuy/src/pages/\\[locale\\]/index.astro";
    writeRepoFile(fixture.repo, routeFile, "---\nconst locale = Astro.params.locale;\n---\n");

    const result = runCommitQueue(fixture.repo, ["add", routeFile], {
      state: fixture.state,
      env,
    });

    assert.equal(result.status, 0, result.stderr);

    const escapedResult = runCommitQueue(fixture.repo, ["add", escapedRoutePathspec], {
      state: fixture.state,
      env,
    });

    assert.equal(escapedResult.status, 0, escapedResult.stderr);

    const sharedIndex = runRealGit(fixture.repo, ["diff", "--cached", "--name-only"]);
    assert.equal(sharedIndex.stdout.trim(), "");

    const privateIndex = runRealGitWithIndex(
      fixture.repo,
      sessionIndexPath(fixture.state, env.COMMIT_QUEUE_ID),
      ["diff", "--cached", "--name-only"],
    );
    assert.equal(privateIndex.stdout.trim(), routeFile);
  } finally {
    fixture.cleanup();
  }
});

test("cached inspection commands read the active session index", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status, 0);

    const diff = runCommitQueue(fixture.repo, ["diff", "--cached", "--name-only"], {
      state: fixture.state,
      env,
    });
    const status = runCommitQueue(fixture.repo, ["status", "--short"], {
      state: fixture.state,
      env,
    });

    assert.equal(diff.status, 0, diff.stderr);
    assert.equal(diff.stdout.trim(), "src/a.ts");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /^A  src\/a\.ts/m);
    assert.equal(runRealGit(fixture.repo, ["diff", "--cached", "--name-only"]).stdout.trim(), "");
  } finally {
    fixture.cleanup();
  }
});

test("explicit add can stage one deleted tracked file", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    rmSync(path.join(fixture.repo, "README.md"));

    const result = runCommitQueue(fixture.repo, ["add", "README.md"], {
      state: fixture.state,
      env,
    });

    assert.equal(result.status, 0, result.stderr);

    const privateIndex = runRealGitWithIndex(
      fixture.repo,
      sessionIndexPath(fixture.state, env.COMMIT_QUEUE_ID),
      ["diff", "--cached", "--name-status"],
    );
    assert.equal(privateIndex.stdout.trim(), "D\tREADME.md");
    assert.equal(runRealGit(fixture.repo, ["diff", "--cached", "--name-only"]).stdout.trim(), "");

    const commit = runCommitQueue(fixture.repo, ["commit", "-m", "test: delete readme"], {
      state: fixture.state,
      env,
    });

    assert.equal(commit.status, 0, commit.stderr);
    assert.equal(runRealGit(fixture.repo, ["log", "-1", "--pretty=%s"]).stdout.trim(), "test: delete readme");
    assert.equal(existsSync(path.join(fixture.repo, "README.md")), false);
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
      env: { ...env, COMMIT_QUEUE_JSON: "1" },
    });

    assert.notEqual(result.status, 0);
    const error = JSON.parse(result.stderr);
    assert.equal(error.error_code, "COMMIT_QUEUE_PATHSPEC_NOT_FOUND");
    assert.equal(error.context.cwd, fixture.repo);
    assert.deepEqual(error.context.pathspecs, ["missing.ts"]);
    assert.match(error.context.git_stderr, /pathspec|did not match any files/);
    assert.match(error.suggestions.join("\n"), /git status --short -- missing\.ts/);
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
    const message = runRealGit(fixture.repo, ["log", "-1", "--format=%B"]).stdout;
    assert.match(message, new RegExp(`Commit-Queue-Session: ${env.COMMIT_QUEUE_ID}`));
    assert.match(message, /Coding-Agent: codex/);
    assert.match(message, /Coding-Agent-Session: codex-test-session/);
    assert.equal(runRealGit(fixture.repo, ["status", "--short"]).stdout.trim(), "");
    assert.deepEqual(readdirSync(path.join(fixture.state, "locks")), []);
  } finally {
    fixture.cleanup();
  }
});

test("commit blocks reserved attribution trailers from command args", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status, 0);

    for (const args of [
      ["commit", "-m", "test: spoof", "--trailer", "Coding-Agent: human"],
      ["commit", "-m", "test: spoof", "--trailer=Commit-Queue-Session: cq_fake"],
      ["commit", "-m", "test: spoof", "--trailer", "coding-agent-session=codex-fake"],
    ]) {
      const result = runCommitQueue(fixture.repo, args, {
        state: fixture.state,
        env,
      });

      assert.notEqual(result.status, 0, `${args.join(" ")} should fail`);
      assert.match(result.stderr, /COMMIT_QUEUE_RESERVED_TRAILER_BLOCKED/);
      assert.match(result.stderr, /reserved for commit-queue attribution/);
    }

    assert.equal(runRealGit(fixture.repo, ["log", "-1", "--pretty=%s"]).stdout.trim(), "test: initial");
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

test("commit --no-post-rewrite is blocked as a hook bypass", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status, 0);

    const result = runCommitQueue(fixture.repo, ["commit", "--no-post-rewrite", "-m", "test: skip hook"], {
      state: fixture.state,
      env,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_NO_VERIFY_BLOCKED/);
    assert.equal(runRealGit(fixture.repo, ["log", "-1", "--pretty=%s"]).stdout.trim(), "test: initial");
  } finally {
    fixture.cleanup();
  }
});

test("commit with hook-path config override is blocked", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status, 0);

    const result = runCommitQueue(fixture.repo, [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "test: bypass hooks",
    ], { state: fixture.state, env });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_UNSAFE_CONFIG_OVERRIDE/);
    assert.equal(runRealGit(fixture.repo, ["log", "-1", "--pretty=%s"]).stdout.trim(), "test: initial");
  } finally {
    fixture.cleanup();
  }
});

test("commit --amend is blocked as a history rewrite", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);

    const result = runCommitQueue(fixture.repo, ["commit", "--amend", "-m", "test: rewrite"], {
      state: fixture.state,
      env,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_AMEND_BLOCKED/);
    assert.match(result.stderr, /follow-up commit/);
    assert.match(result.stderr, /ask the human/);
    assert.doesNotMatch(result.stderr, /Use `git add path\/to\/file`/);
  } finally {
    fixture.cleanup();
  }
});

test("commit pathspecs cannot bypass the session index", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    writeRepoFile(fixture.repo, "src/b.ts", "export const b = 1;\n");
    runRealGit(fixture.repo, ["add", "src/a.ts", "src/b.ts"]);
    runRealGit(fixture.repo, ["commit", "-m", "test: track src files"]);

    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 2;\n");
    writeRepoFile(fixture.repo, "src/b.ts", "export const b = 2;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/b.ts"], { state: fixture.state, env }).status, 0);

    const result = runCommitQueue(fixture.repo, ["commit", "src/a.ts", "-m", "test: pathspec"], {
      state: fixture.state,
      env,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_COMMIT_PATHSPEC_BLOCKED/);
    assert.equal(runRealGit(fixture.repo, ["log", "-1", "--pretty=%s"]).stdout.trim(), "test: track src files");
    assert.match(runRealGit(fixture.repo, ["status", "--short"]).stdout, /src\/a\.ts/);
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

test("commit blocks sessions without coding agent metadata", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status, 0);

    const sessionPath = path.join(fixture.state, "sessions", `${env.COMMIT_QUEUE_ID}.json`);
    const session = JSON.parse(readFileSync(sessionPath, "utf8"));
    delete session.agent;
    writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);

    const result = runCommitQueue(fixture.repo, ["commit", "-m", "test: missing attribution"], {
      state: fixture.state,
      env,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_AGENT_ID_REQUIRED/);
    assert.equal(runRealGit(fixture.repo, ["log", "-1", "--pretty=%s"]).stdout.trim(), "test: initial");
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

test("commit blocks when symbolic HEAD changed after session creation", () => {
  const fixture = createFixture();
  try {
    const env = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");
    assert.equal(runCommitQueue(fixture.repo, ["add", "src/a.ts"], { state: fixture.state, env }).status, 0);

    runRealGit(fixture.repo, ["checkout", "-b", "same-head"]);

    const commit = runCommitQueue(fixture.repo, ["commit", "-m", "test: add a"], {
      state: fixture.state,
      env,
    });

    assert.notEqual(commit.status, 0);
    assert.match(commit.stderr, /COMMIT_QUEUE_HEAD_REF_DRIFT/);
    assert.equal(runRealGit(fixture.repo, ["branch", "--show-current"]).stdout.trim(), "same-head");
    assert.equal(runRealGit(fixture.repo, ["log", "-1", "--pretty=%s"]).stdout.trim(), "test: initial");
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

test("human Git passthrough is blocked without an interactive terminal", () => {
  const fixture = createFixture();
  try {
    writeRepoFile(fixture.repo, "src/a.ts", "export const a = 1;\n");

    const result = runHgit(fixture.repo, ["add", "."], { state: fixture.state });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMMIT_QUEUE_HUMAN_GIT_TTY_REQUIRED/);
    assert.match(result.stderr, /ask the human/);
    assert.equal(runRealGit(fixture.repo, ["diff", "--cached", "--name-only"]).stdout.trim(), "");
  } finally {
    fixture.cleanup();
  }
});

function repoLockPath(state, repo) {
  const lockName = createHash("sha256").update(repo).digest("hex").slice(0, 24);
  return path.join(state, "locks", `${lockName}.lock`);
}
