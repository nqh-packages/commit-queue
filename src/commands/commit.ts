import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { requireAgentIdentity } from "../agent-identity.js";
import {
  firstReservedCommitTrailer,
  inspectCommitArgs,
} from "../command-policy.js";
import { errorPayload, exitWithResult, fail } from "../errors.js";
import {
  currentHead,
  currentHeadRef,
  listStagedPaths,
  runGit,
  stagedBlob,
  worktreeBlob,
} from "../git-runtime.js";
import { withRepoLock } from "../repo-lock.js";
import { requireSession, sessionMissingError } from "../session-guard.js";
import { loadSession, saveSession } from "../session-store.js";
import type { CommitQueueSession } from "../types.js";

type CommitExecution = {
  realGit: string;
  repo: string;
  args: string[];
  pathspecs: string[];
  sessionId: string;
  commandCwd: string;
  globalArgs: string[];
};

export function handleCommit(
  realGit: string,
  repo: string,
  args: string[],
  globalArgs: string[] = [],
): void {
  const policy = inspectCommitArgs(args);
  const session = requireSession("commit", repo, {
    realGit,
    autoBootstrap: true,
  });
  assertNoBlockedPolicy(policy, args, repo, session.id);
  assertNoReservedAttributionTrailers(args, repo, session.id);

  withRepoLock(repo, () => {
    commitWithFreshSession({
      realGit,
      repo,
      args,
      pathspecs: policy.pathspecs,
      sessionId: session.id,
      commandCwd: process.cwd(),
      globalArgs,
    });
  });
}

function assertNoBlockedPolicy(
  policy: ReturnType<typeof inspectCommitArgs>,
  args: string[],
  repo: string,
  sessionId: string | null,
): void {
  if (policy.commitAll) {
    fail(
      errorPayload({
        code: "COMMIT_QUEUE_COMMIT_ALL_BLOCKED",
        title: "Commit all blocked",
        detail: "`git commit -a` bypasses explicit protected staging.",
        context: commitContext(args, repo, sessionId),
        suggestions: [
          'Use `git add path/to/file`, then `git commit -m "message"`.',
        ],
        retriable: true,
      }),
    );
  }

  if (policy.noVerify) {
    fail(
      errorPayload({
        code: "COMMIT_QUEUE_NO_VERIFY_BLOCKED",
        title: "No-verify commit blocked",
        detail: "Git hook bypass options are blocked in protected mode.",
        context: commitContext(args, repo, sessionId),
        suggestions: [
          "Commit without `--no-verify` so repository hooks can run.",
          "If a hook fails, fix the failing check and retry the commit.",
          "If the hook is a false positive, stop and ask the human.",
        ],
        retriable: true,
      }),
    );
  }

  if (policy.amend) {
    fail(
      errorPayload({
        code: "COMMIT_QUEUE_AMEND_BLOCKED",
        title: "Amend blocked",
        detail:
          "`git commit --amend` rewrites the current commit and is blocked in protected mode.",
        context: commitContext(args, repo, sessionId),
        suggestions: [
          "Create a follow-up commit instead of rewriting history.",
          "If the latest commit message must be rewritten, stop and ask the human.",
        ],
        retriable: false,
      }),
    );
  }

  const unsupportedPathspecOption = policy.pathspecOptions[0];
  if (unsupportedPathspecOption) {
    fail(
      errorPayload({
        code: "COMMIT_QUEUE_COMMIT_PATHSPEC_BLOCKED",
        title: "Commit pathspec blocked",
        detail:
          "Commit pathspec options can bypass protected staging and are blocked.",
        context: {
          ...commitContext(args, repo, sessionId),
          pathspecs: policy.pathspecs,
          unsupported_pathspec_option: unsupportedPathspecOption,
        },
        suggestions: [
          'Use plain path arguments after staging, for example `git commit src/file.ts -m "message"`.',
        ],
        retriable: true,
      }),
    );
  }
}

function commitWithFreshSession(execution: CommitExecution): void {
  const freshSession = loadSession(execution.sessionId);
  if (!freshSession) {
    fail(sessionMissingError("commit", execution.repo, execution.sessionId));
  }

  assertNoHeadDrift(execution.realGit, execution.repo, freshSession);
  assertSessionHasExpectedStagedPaths(
    execution.realGit,
    execution.repo,
    freshSession,
  );
  assertNoFileDrift(execution.realGit, execution.repo, freshSession);
  const selectedPaths = selectedCommitPaths(execution, freshSession);
  const agent = requireAgentIdentity("commit", execution.repo, freshSession);
  const commitIndexPath =
    selectedPaths === null
      ? freshSession.indexPath
      : filteredCommitIndex(
          execution.realGit,
          execution.repo,
          freshSession,
          selectedPaths,
        );

  const commit = runGit(
    execution.realGit,
    [
      ...execution.globalArgs,
      "commit",
      ...commitArgsWithoutPathspecs(execution.args),
      ...attributionTrailerArgs(freshSession.id, agent),
    ],
    {
      cwd: execution.commandCwd,
      env: { GIT_INDEX_FILE: commitIndexPath },
    },
  );
  if (commitIndexPath !== freshSession.indexPath) {
    rmSync(path.dirname(commitIndexPath), { recursive: true, force: true });
  }
  if (commit.status !== 0) {
    exitWithResult(commit);
  }

  runGit(
    execution.realGit,
    [...execution.globalArgs, "reset", "-q", "--mixed", "HEAD"],
    {
      cwd: execution.commandCwd,
    },
  );

  freshSession.head = currentHead(execution.realGit, execution.repo);
  freshSession.stagedPaths = recordStagedPaths(
    execution.realGit,
    execution.repo,
    freshSession.indexPath,
  );
  saveSession(freshSession);
  exitWithResult(commit);
}

function assertNoReservedAttributionTrailers(
  args: string[],
  repo: string,
  sessionId: string | null,
): void {
  const trailer = firstReservedCommitTrailer(args);
  if (!trailer) return;

  fail(
    errorPayload({
      code: "COMMIT_QUEUE_RESERVED_TRAILER_BLOCKED",
      title: "Reserved commit trailer blocked",
      detail:
        "Commit-queue attribution trailers are reserved for commit-queue attribution and cannot be supplied by command args.",
      context: {
        ...commitContext(args, repo, sessionId),
        trailer_key: trailer.key,
        trailer_arg: trailer.arg,
      },
      suggestions: [
        "Remove the reserved `--trailer` argument and retry the commit.",
        "Use the commit message body for normal notes; commit-queue will add attribution trailers automatically.",
      ],
      retriable: true,
    }),
  );
}

function commitContext(
  args: string[],
  repo: string,
  sessionId: string | null,
): Record<string, unknown> {
  return {
    command: "commit",
    args,
    repo,
    ...(sessionId ? { session: sessionId } : {}),
  };
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

function selectedCommitPaths(
  execution: CommitExecution,
  session: CommitQueueSession,
): Set<string> | null {
  if (execution.pathspecs.length === 0) return null;

  const matchingPaths = matchingSessionPaths(execution, session.indexPath);
  const stagedPaths = new Set(Object.keys(session.stagedPaths || {}));
  const selectedPaths = new Set(
    [...matchingPaths].filter((matchedPath) => stagedPaths.has(matchedPath)),
  );
  if (selectedPaths.size === 0) {
    fail(
      errorPayload({
        code: "COMMIT_QUEUE_COMMIT_PATHSPEC_NOT_STAGED",
        title: "Commit pathspec not staged",
        detail:
          "Commit path arguments must match paths already staged in this commit-queue session.",
        context: {
          ...commitContext(execution.args, execution.repo, session.id),
          pathspecs: execution.pathspecs,
          staged_paths: Object.keys(session.stagedPaths || {}).sort(),
        },
        suggestions: [
          "Run `git add path/to/file` for the intended paths, then retry the commit.",
          "Use a path argument that matches the session-staged path set.",
        ],
        retriable: true,
      }),
    );
  }

  return selectedPaths;
}

function matchingSessionPaths(
  execution: CommitExecution,
  indexPath: string,
): Set<string> {
  const result = runGit(
    execution.realGit,
    [
      ...execution.globalArgs,
      "ls-files",
      "--full-name",
      "--cached",
      "--",
      ...execution.pathspecs,
    ],
    {
      cwd: execution.commandCwd,
      env: { GIT_INDEX_FILE: indexPath },
    },
  );
  if (result.status !== 0) return new Set();
  return new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function filteredCommitIndex(
  realGit: string,
  repo: string,
  session: CommitQueueSession,
  selectedPaths: Set<string>,
): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "commit-queue-index-"));
  const tempIndex = path.join(tempDir, "index");
  copyFileSync(session.indexPath, tempIndex);

  for (const stagedPath of Object.keys(session.stagedPaths || {})) {
    if (selectedPaths.has(stagedPath)) continue;
    runGit(realGit, ["reset", "-q", "HEAD", "--", stagedPath], {
      cwd: repo,
      env: { GIT_INDEX_FILE: tempIndex },
    });
  }

  return tempIndex;
}

function commitArgsWithoutPathspecs(args: string[]): string[] {
  const state = {
    stripped: [] as string[],
    consumeNext: false,
    afterSeparator: false,
  };

  for (const arg of args) {
    stripCommitArgPathspec(arg, state);
  }

  return state.stripped;
}

type CommitArgStripState = {
  stripped: string[];
  consumeNext: boolean;
  afterSeparator: boolean;
};

function stripCommitArgPathspec(arg: string, state: CommitArgStripState): void {
  if (state.consumeNext) {
    state.stripped.push(arg);
    state.consumeNext = false;
    return;
  }

  if (state.afterSeparator) return;
  if (arg === "--") {
    state.afterSeparator = true;
    return;
  }

  stripCommitOptionOrPathspec(arg, state);
}

function stripCommitOptionOrPathspec(
  arg: string,
  state: CommitArgStripState,
): void {
  if (commitLongOptionConsumesNext(arg)) {
    state.stripped.push(arg);
    state.consumeNext = !arg.includes("=");
    return;
  }

  if (commitShortOptionConsumesNext(arg)) {
    state.stripped.push(arg);
    state.consumeNext = true;
    return;
  }

  if (arg.startsWith("-")) {
    state.stripped.push(arg);
  }
}

function commitLongOptionConsumesNext(arg: string): boolean {
  if (arg.includes("=")) return false;
  return [
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
  ].includes(arg);
}

function commitShortOptionConsumesNext(arg: string): boolean {
  if (["-m", "-F", "-C", "-c"].includes(arg)) return true;
  return /^-[A-Za-z]*[mFCc]$/.test(arg);
}

function recordStagedPaths(
  realGit: string,
  repo: string,
  indexPath: string,
): CommitQueueSession["stagedPaths"] {
  const staged: CommitQueueSession["stagedPaths"] = {};
  for (const relativePath of listStagedPaths(realGit, repo, indexPath)) {
    staged[relativePath] = {
      blob: stagedBlob(realGit, repo, indexPath, relativePath),
      addedAt: new Date().toISOString(),
    };
  }
  return staged;
}

function assertNoHeadDrift(
  realGit: string,
  repo: string,
  session: CommitQueueSession,
): void {
  const head = currentHead(realGit, repo);
  if (head !== session.head) {
    fail(
      errorPayload({
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
          'Run `eval "$(git getID)"` to start a fresh session from the current HEAD.',
          "Stage the intended files again before committing.",
        ],
        retriable: true,
      }),
    );
  }

  const headRef = currentHeadRef(realGit, repo);
  if (headRef !== session.headRef) {
    fail(
      errorPayload({
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
          'Run `eval "$(git getID)"` from the current branch to start a fresh session.',
          "Stage the intended files again before committing.",
        ],
        retriable: true,
      }),
    );
  }
}

function assertSessionHasExpectedStagedPaths(
  realGit: string,
  repo: string,
  session: CommitQueueSession,
): void {
  const stagedPaths = listStagedPaths(realGit, repo, session.indexPath);
  if (stagedPaths.length === 0) {
    fail(
      errorPayload({
        code: "COMMIT_QUEUE_NOTHING_STAGED",
        title: "Nothing staged",
        detail: "This commit-queue session has no staged paths.",
        context: { command: "commit", repo, session: session.id },
        suggestions: ["Use `git add path/to/file` before committing."],
        retriable: true,
      }),
    );
  }

  const recordedPaths = Object.keys(session.stagedPaths || {}).sort();
  if (
    JSON.stringify([...stagedPaths].sort()) !== JSON.stringify(recordedPaths)
  ) {
    fail(
      errorPayload({
        code: "COMMIT_QUEUE_STAGED_PATH_MISMATCH",
        title: "Staged path set changed",
        detail:
          "The session index no longer matches the recorded staged path set.",
        context: {
          command: "commit",
          repo,
          session: session.id,
          staged_paths: stagedPaths,
          recorded_paths: recordedPaths,
        },
        suggestions: [
          "Run `git add path/to/file` again for the intended files.",
        ],
        retriable: true,
      }),
    );
  }
}

function assertNoFileDrift(
  realGit: string,
  repo: string,
  session: CommitQueueSession,
): void {
  for (const relativePath of listStagedPaths(
    realGit,
    repo,
    session.indexPath,
  )) {
    const stagedPath = session.stagedPaths[relativePath];
    const actual = worktreeBlob(realGit, repo, relativePath);
    if (!stagedPath || actual !== stagedPath.blob) {
      fail(
        errorPayload({
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
          suggestions: [
            `Run \`git add ${relativePath}\` again if this content is intentional.`,
          ],
          retriable: true,
        }),
      );
    }
  }
}
