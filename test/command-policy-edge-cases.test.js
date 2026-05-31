// @rust-exception rationale: commit-queue's existing behavior suite is Node test-runner based, and these edge cases must import the TypeScript command-policy build directly.
import assert from "node:assert/strict";
import test from "node:test";
import {
  explicitPathArgs,
  firstUnsafeConfigMutation,
  hasBroadAdd,
  hasGlobalConfigOverride,
  inspectCommitArgs,
  isConfigReadOnly,
  parseInvocation,
} from "../dist/command-policy.js";

test("add path parsing preserves dash-leading filenames after separator", () => {
  assert.deepEqual(explicitPathArgs(["--", "-leading.ts"]), ["-leading.ts"]);
});

test("commit policy blocks equals-form pathspec options", () => {
  assert.deepEqual(inspectCommitArgs(["--only=src/a.ts", "-m", "x"]), {
    commitAll: false,
    noVerify: false,
    amend: false,
    pathspecs: ["--only=src/a.ts"],
    pathspecOptions: ["--only=src/a.ts"],
  });

  assert.deepEqual(inspectCommitArgs(["--include=src/a.ts", "-m", "x"]), {
    commitAll: false,
    noVerify: false,
    amend: false,
    pathspecs: ["--include=src/a.ts"],
    pathspecOptions: ["--include=src/a.ts"],
  });
});

test("commit policy keeps dash-leading path after separator as a pathspec", () => {
  assert.deepEqual(inspectCommitArgs(["-m", "x", "--", "-leading.ts"]), {
    commitAll: false,
    noVerify: false,
    amend: false,
    pathspecs: ["-leading.ts"],
    pathspecOptions: [],
  });
});

test("mixed config read and hook mutation is not read-only", () => {
  assert.equal(
    isConfigReadOnly(["--get", "core.hooksPath", "--unset", "core.hooksPath"]),
    false,
  );
});

test("joined global config overrides are classified before protected commit", () => {
  const invocation = parseInvocation([
    "-ccore.hooksPath=/dev/null",
    "commit",
    "-m",
    "x",
  ]);
  assert.equal(invocation.command, "commit");
  assert.deepEqual(invocation.globalArgs, ["-ccore.hooksPath=/dev/null"]);
  assert.equal(hasGlobalConfigOverride(invocation.globalArgs), true);
});

test("config-env global overrides are classified before protected commit", () => {
  assert.equal(
    hasGlobalConfigOverride(["--config-env=core.hooksPath=HOOKS_PATH"]),
    true,
  );
  assert.equal(
    hasGlobalConfigOverride(["--config-env", "core.hooksPath=HOOKS_PATH"]),
    true,
  );
});

test("safe inline config is still unsafe for protected commits", () => {
  assert.equal(hasGlobalConfigOverride(["-c", "protocol.version=2"]), true);
});

test("commit policy blocks combined commit-all short options", () => {
  assert.equal(inspectCommitArgs(["-am", "x"]).commitAll, true);
  assert.equal(inspectCommitArgs(["-na", "x"]).commitAll, true);
});

test("commit policy blocks equals-form unsafe boolean options", () => {
  assert.equal(inspectCommitArgs(["--all=true", "-m", "x"]).commitAll, true);
  assert.equal(
    inspectCommitArgs(["--no-verify=true", "-m", "x"]).noVerify,
    true,
  );
  assert.equal(inspectCommitArgs(["--amend=true", "-m", "x"]).amend, true);
});

test("commit separator without pathspec leaves full session commit policy", () => {
  assert.deepEqual(inspectCommitArgs(["-m", "x", "--"]), {
    commitAll: false,
    noVerify: false,
    amend: false,
    pathspecs: [],
    pathspecOptions: [],
  });
});

test("broad top-level glob magic add is blocked", () => {
  assert.equal(hasBroadAdd([":(glob)/**/*"]), true);
});

test("pathspec-from-file with equals form is broad add", () => {
  assert.equal(hasBroadAdd(["--pathspec-from-file=paths.txt"]), true);
});

test("hook section removal is an unsafe config mutation", () => {
  assert.deepEqual(
    firstUnsafeConfigMutation(["--remove-section", "hook.lint"]),
    {
      key: "hook.lint",
      reason: "hook_config",
    },
  );
});

test("hook section rename is an unsafe config mutation", () => {
  assert.deepEqual(
    firstUnsafeConfigMutation(["--rename-section", "hook.lint", "hook.safe"]),
    {
      key: "hook.lint",
      reason: "hook_config",
    },
  );
});

test("scoped config get stays read-only", () => {
  assert.equal(isConfigReadOnly(["--global", "--get", "user.email"]), true);
});
