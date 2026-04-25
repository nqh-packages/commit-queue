import {
  firstUnsafeConfigMutation,
  hasGlobalConfigOverride,
  isConfigReadOnly,
  parseInvocation,
} from "./command-policy.js";
import { handleAdd } from "./commands/add.js";
import { handleCommit } from "./commands/commit.js";
import { createSession } from "./commands/get-id.js";
import { errorPayload, exitWithResult, fail } from "./errors.js";
import { isRepoOptedOut, resolveRealGit, resolveRepo, runGit } from "./git-runtime.js";
import { detectHumanNoVerifyBypass, writeHumanNoVerifyBypassEvent } from "./human-bypass.js";
import { assertNoFailedInstallRefresh } from "./install-refresh-guard.js";
import { requireSession } from "./session-guard.js";

export function runProtectedGit(args: string[]): void {
  const realGit = resolveRealGit();
  const invocation = parseInvocation(args);
  const command = invocation.command;

  if (!command) {
    exitWithResult(runGit(realGit, args));
  }

  const repo = resolveRepo(realGit, invocation.globalArgs);
  if (!repo) {
    if (command === "getID") {
      fail(errorPayload({
        code: "COMMIT_QUEUE_NOT_IN_REPO",
        title: "Not inside a Git repository",
        detail: "`git getID` must be run inside a Git repository.",
        context: { command },
        suggestions: ["Run `git getID` from inside the repository you want to protect."],
        retriable: true,
      }));
    }
    exitWithResult(runGit(realGit, args));
  }

  if (isRepoOptedOut(repo)) {
    exitWithResult(runGit(realGit, args));
  }

  if (command === "getID") {
    createSession(realGit, repo);
    return;
  }

  if (command === "commit") {
    const bypass = detectHumanNoVerifyBypass(invocation.commandArgs);
    if (bypass) {
      const commit = runGit(realGit, [...invocation.globalArgs, "commit", ...bypass.sanitizedArgs]);
      if (commit.status === 0) writeHumanNoVerifyBypassEvent(repo);
      exitWithResult(commit);
    }
  }

  if (command === "commit" && hasGlobalConfigOverride(invocation.globalArgs)) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_UNSAFE_CONFIG_OVERRIDE",
      title: "Unsafe Git config override blocked",
      detail: "Inline Git config overrides are blocked for protected commits.",
      context: { command, global_args: invocation.globalArgs, repo },
      suggestions: ["Run `git commit` without inline `-c` or `--config-env` overrides."],
      retriable: true,
    }));
  }

  if (command === "config") {
    const unsafeConfig = firstUnsafeConfigMutation(invocation.commandArgs);
    if (unsafeConfig && !isConfigReadOnly(invocation.commandArgs)) {
      fail(errorPayload({
        code: "COMMIT_QUEUE_HOOK_CONFIG_MUTATION_BLOCKED",
        title: "Hook config mutation blocked",
        detail: "Git hook configuration controls repository gates and cannot be changed by protected git.",
        context: {
          command,
          args: invocation.commandArgs,
          repo,
          unsafe_config: unsafeConfig,
        },
        suggestions: [
          "Leave repository hooks enabled and retry the original command.",
          "If hook configuration must change, stop and ask the human.",
        ],
        retriable: false,
      }));
    }
  }

  if (command === "history") {
    fail(errorPayload({
      code: "COMMIT_QUEUE_HISTORY_REWRITE_BLOCKED",
      title: "History rewrite blocked",
      detail: "`git history` rewrites commit history and does not currently run hooks.",
      context: { command, args: invocation.commandArgs, repo },
      suggestions: [
        "Create a follow-up commit instead of rewriting history.",
        "If history must be rewritten, stop and ask the human.",
      ],
      retriable: false,
    }));
  }

  if (command === "add") {
    assertNoFailedInstallRefresh(command, repo);
    handleAdd(realGit, repo, invocation.commandArgs, invocation.globalArgs);
    return;
  }

  if (command === "commit") {
    assertNoFailedInstallRefresh(command, repo);
    handleCommit(realGit, repo, invocation.commandArgs);
    return;
  }

  const env = indexAwareReadEnv(command, repo);
  if (env) {
    exitWithResult(runGit(realGit, args, { env }));
  }
  exitWithResult(runGit(realGit, args));
}

function indexAwareReadEnv(command: string, repo: string): NodeJS.ProcessEnv | undefined {
  if (!process.env.COMMIT_QUEUE_ID || !usesGitIndexForInspection(command)) return undefined;
  const session = requireSession(command, repo);
  return { GIT_INDEX_FILE: session.indexPath };
}

function usesGitIndexForInspection(command: string): boolean {
  return command === "status" || command === "diff" || command === "ls-files" || command === "show";
}

export function runHumanGit(args: string[]): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_HUMAN_GIT_TTY_REQUIRED",
      title: "Human Git requires an interactive terminal",
      detail: "Human Git passthrough requires an interactive terminal.",
      context: { command: args[0] || null },
      suggestions: [
        "Use protected git commands from agent sessions.",
        "If protected mode is blocking a real false positive, stop and ask the human.",
      ],
      retriable: false,
    }));
  }

  exitWithResult(runGit(resolveRealGit(), args));
}
