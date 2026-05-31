// @rust-exception rationale: commit-queue's existing integration fixtures are Node test-runner based, and these cases must exercise the local Git shim through those fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  activateSession,
  createFixture,
  defaultAgentEnv,
  runCommitQueue,
  runRealGit,
  writeRepoFile,
} from "./helpers/git-fixture.js";

test("commit pathspecs resolve from the command subdirectory", () => {
  const fixture = createFixture();
  try {
    const agentEnv = activateSession(fixture.repo, fixture.state);
    const subdir = path.join(fixture.repo, "apps/booknow");
    writeRepoFile(
      fixture.repo,
      "apps/booknow/Sources/File.swift",
      "let value = 1\n",
    );

    const add = runCommitQueue(subdir, ["add", "Sources/File.swift"], {
      state: fixture.state,
      env: agentEnv,
    });
    assert.equal(add.status, 0, add.stderr);

    const commit = runCommitQueue(
      subdir,
      ["commit", "Sources/File.swift", "-m", "test: subdir pathspec"],
      { state: fixture.state, env: agentEnv },
    );
    assert.equal(commit.status, 0, commit.stderr);

    const committed = runRealGit(fixture.repo, [
      "show",
      "--name-only",
      "--pretty=format:",
      "HEAD",
    ]);
    assert.match(committed.stdout, /apps\/booknow\/Sources\/File.swift/);
  } finally {
    fixture.cleanup();
  }
});

test("commit pathspecs resolve through global -C", () => {
  const fixture = createFixture();
  try {
    const agentEnv = activateSession(fixture.repo, fixture.state);
    writeRepoFile(
      fixture.repo,
      "apps/booknow/Sources/Other.swift",
      "let other = 1\n",
    );

    const add = runCommitQueue(
      fixture.repo,
      ["-C", "apps/booknow", "add", "Sources/Other.swift"],
      { state: fixture.state, env: agentEnv },
    );
    assert.equal(add.status, 0, add.stderr);

    const commit = runCommitQueue(
      fixture.repo,
      [
        "-C",
        "apps/booknow",
        "commit",
        "Sources/Other.swift",
        "-m",
        "test: global c pathspec",
      ],
      { state: fixture.state, env: agentEnv },
    );
    assert.equal(commit.status, 0, commit.stderr);

    const committed = runRealGit(fixture.repo, [
      "show",
      "--name-only",
      "--pretty=format:",
      "HEAD",
    ]);
    assert.match(committed.stdout, /apps\/booknow\/Sources\/Other.swift/);
  } finally {
    fixture.cleanup();
  }
});

test("dash-leading files can be staged and committed after separator", () => {
  const fixture = createFixture();
  try {
    const agentEnv = activateSession(fixture.repo, fixture.state);
    writeRepoFile(fixture.repo, "-leading.ts", "export const value = 1;\n");

    const add = runCommitQueue(fixture.repo, ["add", "--", "-leading.ts"], {
      state: fixture.state,
      env: agentEnv,
    });
    assert.equal(add.status, 0, add.stderr);

    const commit = runCommitQueue(
      fixture.repo,
      ["commit", "-m", "test: dash leading", "--", "-leading.ts"],
      { state: fixture.state, env: agentEnv },
    );
    assert.equal(commit.status, 0, commit.stderr);

    const committed = runRealGit(fixture.repo, [
      "show",
      "--name-only",
      "--pretty=format:",
      "HEAD",
    ]);
    assert.match(committed.stdout, /-leading\.ts/);
  } finally {
    fixture.cleanup();
  }
});

test("corrupt session metadata returns a structured agent error", () => {
  const fixture = createFixture();
  try {
    const agentEnv = activateSession(fixture.repo, fixture.state);
    const sessionPath = path.join(
      fixture.state,
      "sessions",
      `${agentEnv.COMMIT_QUEUE_ID}.json`,
    );
    writeFileSync(sessionPath, "{");
    writeRepoFile(fixture.repo, "src/corrupt-session.ts", "export {}\n");

    const add = runCommitQueue(
      fixture.repo,
      ["add", "src/corrupt-session.ts"],
      {
        state: fixture.state,
        env: agentEnv,
      },
    );

    assert.equal(add.status, 2);
    assert.match(add.stderr, /COMMIT_QUEUE_SESSION_TAMPERED/);
    assert.doesNotMatch(add.stderr, /SyntaxError/);
  } finally {
    fixture.cleanup();
  }
});

test("corrupt active session mapping is replaced during auto-bootstrap", () => {
  const fixture = createFixture();
  try {
    activateSession(fixture.repo, fixture.state);
    const agent = defaultAgentEnv();
    const mappingKey = createHash("sha256")
      .update(
        JSON.stringify([
          fixture.repo,
          agent.COMMIT_QUEUE_AGENT,
          agent.COMMIT_QUEUE_AGENT_SESSION,
        ]),
      )
      .digest("hex");
    const mappingPath = path.join(
      fixture.state,
      "active-sessions",
      `${mappingKey}.json`,
    );
    writeFileSync(mappingPath, "{");
    writeRepoFile(fixture.repo, "src/fresh-session.ts", "export {}\n");

    const add = runCommitQueue(fixture.repo, ["add", "src/fresh-session.ts"], {
      state: fixture.state,
      env: agent,
    });

    assert.equal(add.status, 0, add.stderr);
  } finally {
    fixture.cleanup();
  }
});
