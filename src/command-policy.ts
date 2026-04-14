import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { matchingGitPaths } from "./git-runtime.js";
import type { Invocation } from "./types.js";

const BLOCKED_COMMANDS = new Map<string, string>([
  ["checkout", "COMMIT_QUEUE_SHARED_TREE_MUTATION_BLOCKED"],
  ["switch", "COMMIT_QUEUE_SHARED_TREE_MUTATION_BLOCKED"],
  ["reset", "COMMIT_QUEUE_SHARED_TREE_MUTATION_BLOCKED"],
  ["restore", "COMMIT_QUEUE_SHARED_TREE_MUTATION_BLOCKED"],
  ["merge", "COMMIT_QUEUE_HISTORY_MUTATION_BLOCKED"],
  ["rebase", "COMMIT_QUEUE_HISTORY_MUTATION_BLOCKED"],
  ["pull", "COMMIT_QUEUE_HISTORY_MUTATION_BLOCKED"],
  ["stash", "COMMIT_QUEUE_SHARED_TREE_MUTATION_BLOCKED"],
]);

const PASSTHROUGH_COMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "ls-files",
  "push",
  "help",
  "--help",
  "-h",
  "--version",
  "version",
]);

const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

const GLOBAL_OPTIONS_WITHOUT_VALUE = new Set([
  "-P",
  "-p",
  "--bare",
  "--glob-pathspecs",
  "--icase-pathspecs",
  "--literal-pathspecs",
  "--no-optional-locks",
  "--no-pager",
  "--no-replace-objects",
  "--noglob-pathspecs",
  "--paginate",
]);

const BRANCH_READ_FLAGS = new Set(["--list", "-l", "--all", "-a", "--remotes", "-r"]);
const BRANCH_MUTATION_FLAGS = new Set([
  "--delete",
  "--move",
  "--copy",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
  "--track",
  "--set-upstream",
  "--create-reflog",
]);
const CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"]);
const COMMIT_LONG_OPTIONS_WITH_VALUE = new Set([
  "--message",
  "--file",
  "--reuse-message",
  "--reedit-message",
  "--fixup",
  "--squash",
  "--author",
  "--date",
  "--cleanup",
  "--trailer",
  "--template",
]);

export type CommitPolicy = {
  commitAll: boolean;
  noVerify: boolean;
  amend: boolean;
  pathspecs: string[];
};

export type UnsafeAddPathspec = {
  path: string;
  reason: "wildcard" | "directory" | "matches_multiple_paths";
  matches?: string[];
};

export function blockedCommandCode(command: string): string | null {
  return BLOCKED_COMMANDS.get(command) || null;
}

export function parseInvocation(args: string[]): Invocation {
  const globalArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      globalArgs.push(arg);
      if (index + 1 < args.length) {
        globalArgs.push(args[index + 1] ?? "");
        index += 1;
      }
      continue;
    }

    if (isJoinedGlobalOption(arg) || GLOBAL_OPTIONS_WITHOUT_VALUE.has(arg)) {
      globalArgs.push(arg);
      continue;
    }

    return {
      globalArgs,
      command: arg,
      commandArgs: args.slice(index + 1),
    };
  }

  return {
    globalArgs,
    command: null,
    commandArgs: [],
  };
}

export function isPassthroughCommand(command: string, args: string[]): boolean {
  if (PASSTHROUGH_COMMANDS.has(command)) return true;
  if (command === "branch") return isBranchPassthrough(args);
  return false;
}

export function isReadInspectionCommand(command: string, args: string[]): boolean {
  if (command === "config") return isConfigReadOnly(args);
  if (command === "push") return false;
  return isPassthroughCommand(command, args);
}

export function hasGlobalConfigOverride(globalArgs: string[]): boolean {
  return globalArgs.some((arg) => (
    arg === "-c" ||
    arg.startsWith("-c") ||
    arg === "--config-env" ||
    arg.startsWith("--config-env=")
  ));
}

export function isConfigReadOnly(args: string[]): boolean {
  if (args.length === 1 && !args[0]?.startsWith("-")) return true;
  return args.some((arg) => CONFIG_READ_FLAGS.has(arg));
}

export function isBranchPassthrough(args: string[]): boolean {
  if (args.length === 0) return true;

  const hasListMode = args.some((arg) => BRANCH_READ_FLAGS.has(arg));
  for (const arg of args) {
    if (isBranchMutationArg(arg)) return false;
    if (!arg.startsWith("-") && !hasListMode) return false;
  }

  return true;
}

export function hasUnsafePush(args: string[]): boolean {
  return args.some((arg) => (
    arg === "--force" ||
    arg === "-f" ||
    arg === "--delete" ||
    arg === "-d" ||
    arg === "--no-verify" ||
    arg === "--all" ||
    arg === "--tags" ||
    arg === "--mirror" ||
    arg === "--prune" ||
    arg.startsWith("--force-with-lease") ||
    arg.startsWith("--force-if-includes") ||
    arg.startsWith("+") ||
    arg.startsWith(":")
  ));
}

export function hasBroadAdd(args: string[]): boolean {
  return args.some((arg) => (
    arg === "." ||
    arg === ":/" ||
    arg === ":/*" ||
    arg === "-A" ||
    arg === "--all" ||
    arg === "-u" ||
    arg === "--update" ||
    arg === "--pathspec-from-file" ||
    arg === "--pathspec-file-nul" ||
    arg.startsWith("-A") ||
    arg.startsWith("-u") ||
    arg.startsWith("--pathspec-from-file=") ||
    isBroadPathspec(arg)
  ));
}

export function explicitPathArgs(args: string[]): string[] {
  return args.filter((arg) => arg !== "--" && !arg.startsWith("-"));
}

export function firstUnsafeAddPathspec(realGit: string, repo: string, pathArgs: string[]): UnsafeAddPathspec | null {
  for (const pathArg of pathArgs) {
    if (hasPathspecWildcard(pathArg)) {
      return { path: pathArg, reason: "wildcard" };
    }

    const absolutePath = path.isAbsolute(pathArg) ? pathArg : path.join(repo, pathArg);
    if (existsSync(absolutePath) && statSync(absolutePath).isDirectory()) {
      return { path: pathArg, reason: "directory" };
    }

    const matches = matchingGitPaths(realGit, repo, pathArg);
    if (matches.length > 1) {
      return { path: pathArg, reason: "matches_multiple_paths", matches };
    }
  }

  return null;
}

export function inspectCommitArgs(args: string[]): CommitPolicy {
  const policy: CommitPolicy = {
    commitAll: false,
    noVerify: false,
    amend: false,
    pathspecs: [],
  };
  let consumeNext = false;
  let afterSeparator = false;

  for (const arg of args) {
    if (consumeNext) {
      consumeNext = false;
      continue;
    }

    if (afterSeparator) {
      policy.pathspecs.push(arg);
      continue;
    }

    if (arg === "--") {
      afterSeparator = true;
      continue;
    }

    if (arg === "--all") {
      policy.commitAll = true;
      continue;
    }

    if (arg === "--no-verify" || arg === "--no-post-rewrite") {
      policy.noVerify = true;
      continue;
    }

    if (arg === "--amend") {
      policy.amend = true;
      continue;
    }

    if (["--only", "--include", "--pathspec-file-nul"].includes(arg) || arg.startsWith("--pathspec-from-file")) {
      policy.pathspecs.push(arg);
      continue;
    }

    if (commitLongOptionConsumesNext(arg)) {
      consumeNext = true;
      continue;
    }

    if (arg.startsWith("--")) {
      continue;
    }

    if (/^-[^-]/.test(arg)) {
      inspectCommitShortOptions(arg, policy);
      if (commitShortOptionConsumesNext(arg)) {
        consumeNext = true;
      }
      continue;
    }

    policy.pathspecs.push(arg);
  }

  return policy;
}

function isJoinedGlobalOption(arg: string): boolean {
  return (
    arg.startsWith("--config-env=") ||
    arg.startsWith("--exec-path=") ||
    arg.startsWith("--git-dir=") ||
    arg.startsWith("--namespace=") ||
    arg.startsWith("--super-prefix=") ||
    arg.startsWith("--work-tree=") ||
    /^-c[^=]+=.*/.test(arg)
  );
}

function isBranchMutationArg(arg: string): boolean {
  if (BRANCH_MUTATION_FLAGS.has(arg)) return true;
  if (arg.startsWith("--set-upstream-to=")) return true;
  return /^-[^-].*[dDmMcC]/.test(arg);
}

function isBroadPathspec(arg: string): boolean {
  const magic = arg.match(/^:\(([^)]*)\)(.*)$/);
  if (!magic) return false;

  const modifiers = magic[1]?.split(",").map((modifier) => modifier.trim()) || [];
  const pattern = magic[2] || "";
  return modifiers.includes("glob") && (pattern === "**" || pattern === "**/*");
}

function hasPathspecWildcard(pathspec: string): boolean {
  const withoutMagic = pathspec.replace(/^:\([^)]*\)/, "");
  return /[*?\[]/.test(withoutMagic);
}

function commitLongOptionConsumesNext(arg: string): boolean {
  if (arg.includes("=")) return false;
  return COMMIT_LONG_OPTIONS_WITH_VALUE.has(arg);
}

function inspectCommitShortOptions(arg: string, policy: CommitPolicy): void {
  const cluster = arg.slice(1);
  if (cluster.includes("a")) policy.commitAll = true;
  if (cluster.includes("n")) policy.noVerify = true;
  if (cluster.includes("o") || cluster.includes("i")) policy.pathspecs.push(arg);
}

function commitShortOptionConsumesNext(arg: string): boolean {
  if (["-m", "-F", "-C", "-c"].includes(arg)) return true;
  return /^-[A-Za-z]*[mFCc]$/.test(arg);
}
