import { requireAgentIdentity } from "../agent-identity.js";
import { firstReservedCommitTrailer, inspectCommitArgs } from "../command-policy.js";
import { errorPayload, exitWithResult, fail } from "../errors.js";
import { currentHead, currentHeadRef, listStagedPaths, runGit, worktreeBlob } from "../git-runtime.js";
import { withRepoLock } from "../repo-lock.js";
import { requireSession, sessionMissingError } from "../session-guard.js";
import { loadSession, saveSession } from "../session-store.js";
import type { CommitQueueSession } from "../types.js";

export function handleCommit(realGit: string, repo: string, args: string[]): void {
  const session = requireSession("commit", repo);
  const policy = inspectCommitArgs(args);

  if (policy.commitAll) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_COMMIT_ALL_BLOCKED",
      title: "Commit all blocked",
      detail: "`git commit -a` bypasses explicit protected staging.",
      context: { command: "commit", args, repo, session: session.id },
      suggestions: ["Use `git add path/to/file`, then `git commit -m \"message\"`."],
      retriable: true,
    }));
  }

  if (policy.noVerify) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_NO_VERIFY_BLOCKED",
      title: "No-verify commit blocked",
      detail: "Git hook bypass options are blocked in protected mode.",
      context: { command: "commit", args, repo, session: session.id },
      suggestions: [
        "Commit without `--no-verify` so repository hooks can run.",
        "If a hook fails, fix the failing check and retry the commit.",
        "If the hook is a false positive, stop and ask the human.",
      ],
      retriable: true,
    }));
  }

  if (policy.amend) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_AMEND_BLOCKED",
      title: "Amend blocked",
      detail: "`git commit --amend` rewrites the current commit and is blocked in protected mode.",
      context: { command: "commit", args, repo, session: session.id },
      suggestions: [
        "Create a follow-up commit instead of rewriting history.",
        "If the latest commit message must be rewritten, stop and ask the human.",
      ],
      retriable: false,
    }));
  }

  if (policy.pathspecs.length > 0) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_COMMIT_PATHSPEC_BLOCKED",
      title: "Commit pathspec blocked",
      detail: "Commit pathspecs can bypass protected staging and are blocked.",
      context: { command: "commit", args, repo, session: session.id, pathspecs: policy.pathspecs },
      suggestions: ["Use `git add path/to/file`, then `git commit -m \"message\"` without path arguments."],
      retriable: true,
    }));
  }

  assertNoReservedAttributionTrailers(args, repo, session.id);

  withRepoLock(repo, () => {
    commitWithFreshSession(realGit, repo, args, session.id);
  });
}

function commitWithFreshSession(realGit: string, repo: string, args: string[], sessionId: string): void {
  const freshSession = loadSession(sessionId);
  if (!freshSession) {
    fail(sessionMissingError("commit", repo, sessionId));
  }

  assertNoHeadDrift(realGit, repo, freshSession);
  assertSessionHasExpectedStagedPaths(realGit, repo, freshSession);
  assertNoFileDrift(realGit, repo, freshSession);
  const agent = requireAgentIdentity("commit", repo, freshSession);

  const commit = runGit(realGit, ["commit", ...args, ...attributionTrailerArgs(freshSession.id, agent)], {
    cwd: repo,
    env: { GIT_INDEX_FILE: freshSession.indexPath },
  });
  if (commit.status !== 0) {
    exitWithCommitFailure(commit, repo, freshSession.id);
  }

  runGit(realGit, ["reset", "-q", "--mixed", "HEAD"], { cwd: repo });

  freshSession.head = currentHead(realGit, repo);
  freshSession.stagedPaths = {};
  saveSession(freshSession);
  exitWithResult(commit);
}

function exitWithCommitFailure(
  result: ReturnType<typeof runGit>,
  repo: string,
  sessionId: string,
): never {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const detected = detectCommitFailure(output);
  const payload = errorPayload({
    code: detected.code,
    title: detected.title,
    detail: detected.detail,
    context: {
      command: "commit",
      repo,
      session: sessionId,
      git_status: result.status,
      likely_cause: detected.likelyCause,
      protected_checks: "passed_before_git_commit",
    },
    suggestions: detected.suggestions,
    retriable: true,
  });

  if (process.env.COMMIT_QUEUE_JSON === "1") {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write([
      "",
      "[commit-queue] git commit failed after protected checks passed.",
      `error_code: ${payload.error_code}`,
      `retriable: ${String(payload.retriable)}`,
      "context:",
      ...JSON.stringify(payload.context, null, 2).split("\n").map((line) => `  ${line}`),
      ...payload.suggestions.map((suggestion) => `suggestion: ${suggestion}`),
      "",
    ].join("\n"));
  }

  process.exit(result.status ?? 1);
}

function detectCommitFailure(output: string): {
  code: string;
  title: string;
  detail: string;
  likelyCause: string;
  suggestions: string[];
} {
  if (output.includes("Contract consumer check failed") || output.includes("contracts:check:frontends")) {
    return {
      code: "COMMIT_QUEUE_GIT_HOOK_CONTRACT_DRIFT",
      title: "Git hook found frontend contract drift",
      detail: "The repository hook failed while checking frontend contract snapshots.",
      likelyCause: "repository_hook_contract_drift",
      suggestions: [
        "Read the hook output above for the exact stale frontend apps.",
        "Run `pnpm contracts:sync:frontends`, then `pnpm contracts:check:frontends` from the backend repo.",
        "Commit synced frontend snapshots separately when the drift is unrelated to the backend change.",
      ],
    };
  }

  if (output.includes("pre-commit") || output.includes("husky")) {
    return {
      code: "COMMIT_QUEUE_GIT_HOOK_FAILED",
      title: "Git hook failed",
      detail: "Git rejected the commit because a repository hook failed.",
      likelyCause: "repository_hook_failed",
      suggestions: [
        "Read the hook output above and run the named check directly from the repo root.",
        "Fix or isolate unrelated existing drift before retrying the commit.",
      ],
    };
  }

  return {
    code: "COMMIT_QUEUE_GIT_COMMIT_FAILED",
    title: "Git commit failed",
    detail: "Git rejected the commit after commit-queue protected checks passed.",
    likelyCause: "git_commit_failed",
    suggestions: [
      "Read the Git output above for the failing condition.",
      "Fix the Git or hook failure, then retry `git commit` with the same staged session.",
    ],
  };
}

function assertNoReservedAttributionTrailers(args: string[], repo: string, sessionId: string): void {
  const trailer = firstReservedCommitTrailer(args);
  if (!trailer) return;

  fail(errorPayload({
    code: "COMMIT_QUEUE_RESERVED_TRAILER_BLOCKED",
    title: "Reserved commit trailer blocked",
    detail: "Commit-queue attribution trailers are reserved for commit-queue attribution and cannot be supplied by command args.",
    context: {
      command: "commit",
      repo,
      session: sessionId,
      trailer_key: trailer.key,
      trailer_arg: trailer.arg,
    },
    suggestions: [
      "Remove the reserved `--trailer` argument and retry the commit.",
      "Use the commit message body for normal notes; commit-queue will add attribution trailers automatically.",
    ],
    retriable: true,
  }));
}

function attributionTrailerArgs(
  sessionId: string,
  agent: { name: string; sessionId: string },
): string[] {
  return [
    "--trailer",
    `Commit-Queue-Session: ${sessionId}`,
    "--trailer",
    `Coding-Agent: ${agent.name}`,
    "--trailer",
    `Coding-Agent-Session: ${agent.sessionId}`,
  ];
}

function assertNoHeadDrift(realGit: string, repo: string, session: CommitQueueSession): void {
  const head = currentHead(realGit, repo);
  if (head !== session.head) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_HEAD_DRIFT",
      title: "Repository HEAD changed",
      detail: "The repository HEAD changed after this session started.",
      context: {
        command: "commit",
        repo,
        session: session.id,
        expected_head: session.head,
        actual_head: head,
      },
      suggestions: [
        "Run `eval \"$(git getID)\"` to start a fresh session from the current HEAD.",
        "Stage the intended files again before committing.",
      ],
      retriable: true,
    }));
  }

  const headRef = currentHeadRef(realGit, repo);
  if (headRef !== session.headRef) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_HEAD_REF_DRIFT",
      title: "Repository HEAD branch changed",
      detail: "The symbolic HEAD target changed after this session started.",
      context: {
        command: "commit",
        repo,
        session: session.id,
        expected_head_ref: session.headRef,
        actual_head_ref: headRef,
      },
      suggestions: [
        "Run `eval \"$(git getID)\"` from the current branch to start a fresh session.",
        "Stage the intended files again before committing.",
      ],
      retriable: true,
    }));
  }
}

function assertSessionHasExpectedStagedPaths(realGit: string, repo: string, session: CommitQueueSession): void {
  const stagedPaths = listStagedPaths(realGit, repo, session.indexPath);
  if (stagedPaths.length === 0) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_NOTHING_STAGED",
      title: "Nothing staged",
      detail: "This commit-queue session has no staged paths.",
      context: { command: "commit", repo, session: session.id },
      suggestions: ["Use `git add path/to/file` before committing."],
      retriable: true,
    }));
  }

  const recordedPaths = Object.keys(session.stagedPaths || {}).sort();
  if (JSON.stringify([...stagedPaths].sort()) !== JSON.stringify(recordedPaths)) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_STAGED_PATH_MISMATCH",
      title: "Staged path set changed",
      detail: "The session index no longer matches the recorded staged path set.",
      context: { command: "commit", repo, session: session.id, staged_paths: stagedPaths, recorded_paths: recordedPaths },
      suggestions: ["Run `git add path/to/file` again for the intended files."],
      retriable: true,
    }));
  }
}

function assertNoFileDrift(realGit: string, repo: string, session: CommitQueueSession): void {
  for (const relativePath of listStagedPaths(realGit, repo, session.indexPath)) {
    const stagedPath = session.stagedPaths[relativePath];
    const actual = worktreeBlob(realGit, repo, relativePath);
    if (!stagedPath || actual !== stagedPath.blob) {
      fail(errorPayload({
        code: "COMMIT_QUEUE_FILE_DRIFT",
        title: "Staged file changed before commit",
        detail: "A staged file changed after this session staged it.",
        context: {
          command: "commit",
          repo,
          session: session.id,
          path: relativePath,
          expected_blob: stagedPath?.blob ?? null,
          actual_blob: actual,
        },
        suggestions: [`Run \`git add ${relativePath}\` again if this content is intentional.`],
        retriable: true,
      }));
    }
  }
}
