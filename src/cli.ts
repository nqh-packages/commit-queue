import {
  blockedCommandCode,
  hasGlobalConfigOverride,
  hasUnsafePush,
  isBranchPassthrough,
  isPassthroughCommand,
  isReadInspectionCommand,
  parseInvocation,
} from "./command-policy.js";
import { handleAdd } from "./commands/add.js";
import { handleCommit } from "./commands/commit.js";
import { handleConfig } from "./commands/config.js";
import { createSession } from "./commands/get-id.js";
import { errorPayload, exitWithResult, fail } from "./errors.js";
import { isRepoOptedOut, resolveRealGit, resolveRepo, runGit } from "./git-runtime.js";
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

  if (hasGlobalConfigOverride(invocation.globalArgs) && !isReadInspectionCommand(command, invocation.commandArgs)) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_UNSAFE_CONFIG_OVERRIDE",
      title: "Unsafe Git config override blocked",
      detail: "Inline Git config overrides are blocked for protected mutating commands.",
      context: { command, global_args: invocation.globalArgs, repo },
      suggestions: ["Run the protected command without inline `-c` or `--config-env` overrides."],
      retriable: true,
    }));
  }

  if (command === "config") {
    handleConfig(realGit, repo, args, invocation.commandArgs);
    return;
  }

  if (command === "branch" && !isBranchPassthrough(invocation.commandArgs)) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_REF_MUTATION_BLOCKED",
      title: "Reference mutation blocked",
      detail: "Git branch mutation is blocked in protected mode.",
      context: { command, args: invocation.commandArgs, repo },
      suggestions: ["Use read-only branch commands, or ask the human if a branch must be changed."],
      retriable: false,
    }));
  }

  if (command === "push" && hasUnsafePush(invocation.commandArgs)) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_UNSAFE_PUSH_BLOCKED",
      title: "Unsafe push blocked",
      detail: "Destructive push options are blocked in protected mode.",
      context: { command, args: invocation.commandArgs, repo },
      suggestions: [
        "Use a normal `git push` without force, delete, mirror, prune, or force refspecs.",
        "If remote history must be rewritten, stop and ask the human.",
      ],
      retriable: false,
    }));
  }

  if (isPassthroughCommand(command, invocation.commandArgs)) {
    exitWithResult(runGit(realGit, args));
  }

  const blockedCode = blockedCommandCode(command);
  if (blockedCode) {
    fail(errorPayload({
      code: blockedCode,
      title: "Shared working tree mutation blocked",
      detail: `Git command '${command}' is blocked in protected mode.`,
      context: { command, repo },
      suggestions: [
        "Use a commit-queue session for `git add path` and `git commit -m`.",
        "Avoid commands that mutate the shared working tree while agents are active.",
      ],
      retriable: false,
    }));
  }

  if (command === "add") {
    handleAdd(realGit, repo, invocation.commandArgs);
    return;
  }

  if (command === "commit") {
    handleCommit(realGit, repo, invocation.commandArgs);
    return;
  }

  const session = requireSession(command, repo);
  fail(errorPayload({
    code: "COMMIT_QUEUE_UNSUPPORTED_MUTATION_BLOCKED",
    title: "Unsupported mutating command blocked",
    detail: `Git command '${command}' is not supported by commit-queue protected mode.`,
    context: { command, repo, session: session.id },
    suggestions: ["Use `git add path/to/file` and `git commit -m \"message\"` for protected commits."],
    retriable: false,
  }));
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
