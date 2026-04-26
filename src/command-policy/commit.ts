import type { CommitPolicy } from "./types.js";

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

const COMMIT_PATHSPEC_OPTIONS = new Set([
  "--only",
  "--include",
  "--pathspec-file-nul",
]);

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

    const state = classifyCommitArg(arg, afterSeparator);
    afterSeparator = state.afterSeparator;
    consumeNext = state.consumeNext;
    applyCommitArgState(policy, arg, state);
  }

  return policy;
}

type CommitArgState = {
  afterSeparator: boolean;
  consumeNext: boolean;
  kind:
    | "skip"
    | "commit_all"
    | "no_verify"
    | "amend"
    | "pathspec"
    | "short_options";
};

function classifyCommitArg(
  arg: string,
  afterSeparator: boolean,
): CommitArgState {
  let state: CommitArgState;

  if (afterSeparator) {
    state = pathspecState(true);
  } else if (arg === "--") {
    state = skipState({ afterSeparator: true });
  } else if (arg === "--all") {
    state = kindState("commit_all");
  } else if (arg === "--no-verify" || arg === "--no-post-rewrite") {
    state = kindState("no_verify");
  } else if (arg === "--amend") {
    state = kindState("amend");
  } else if (isCommitPathspecOption(arg)) {
    state = kindState("pathspec");
  } else if (commitLongOptionConsumesNext(arg)) {
    state = skipState({ consumeNext: true });
  } else if (arg.startsWith("--")) {
    state = skipState();
  } else if (/^-[^-]/.test(arg)) {
    state = kindState("short_options", {
      consumeNext: commitShortOptionConsumesNext(arg),
    });
  } else {
    state = pathspecState(afterSeparator);
  }

  return state;
}

function applyCommitArgState(
  policy: CommitPolicy,
  arg: string,
  state: CommitArgState,
): void {
  if (state.kind === "commit_all") policy.commitAll = true;
  if (state.kind === "no_verify") policy.noVerify = true;
  if (state.kind === "amend") policy.amend = true;
  if (state.kind === "pathspec") policy.pathspecs.push(arg);
  if (state.kind === "short_options") inspectCommitShortOptions(arg, policy);
}

function skipState(
  overrides: Partial<Omit<CommitArgState, "kind">> = {},
): CommitArgState {
  return {
    afterSeparator: false,
    consumeNext: false,
    ...overrides,
    kind: "skip",
  };
}

function kindState(
  kind: CommitArgState["kind"],
  overrides: Partial<Omit<CommitArgState, "kind">> = {},
): CommitArgState {
  return {
    afterSeparator: false,
    consumeNext: false,
    ...overrides,
    kind,
  };
}

function pathspecState(afterSeparator: boolean): CommitArgState {
  return {
    afterSeparator,
    consumeNext: false,
    kind: "pathspec",
  };
}

function isCommitPathspecOption(arg: string): boolean {
  return (
    COMMIT_PATHSPEC_OPTIONS.has(arg) || arg.startsWith("--pathspec-from-file")
  );
}

function commitLongOptionConsumesNext(arg: string): boolean {
  if (arg.includes("=")) return false;
  return COMMIT_LONG_OPTIONS_WITH_VALUE.has(arg);
}

function inspectCommitShortOptions(arg: string, policy: CommitPolicy): void {
  const cluster = arg.slice(1);
  if (cluster.includes("a")) policy.commitAll = true;
  if (cluster.includes("n")) policy.noVerify = true;
  if (cluster.includes("o") || cluster.includes("i"))
    policy.pathspecs.push(arg);
}

function commitShortOptionConsumesNext(arg: string): boolean {
  if (["-m", "-F", "-C", "-c"].includes(arg)) return true;
  return /^-[A-Za-z]*[mFCc]$/.test(arg);
}
