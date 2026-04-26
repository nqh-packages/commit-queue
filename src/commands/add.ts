import {
  explicitPathArgs,
  firstUnsafeAddPathspec,
  hasBroadAdd,
} from "../command-policy.js";
import { errorPayload, exitWithResult, fail } from "../errors.js";
import {
  listStagedPaths,
  resolveGitPathBase,
  runGit,
  stagedBlob,
} from "../git-runtime.js";
import { requireSession } from "../session-guard.js";
import { saveSession } from "../session-store.js";
import type { StagedPath } from "../types.js";

export function handleAdd(
  realGit: string,
  repo: string,
  args: string[],
  globalArgs: string[] = [],
): void {
  const session = requireSession("add", repo);
  const commandCwd = process.cwd();
  const pathBaseCwd = resolveGitPathBase(realGit, repo, globalArgs);

  if (hasBroadAdd(args)) {
    fail(
      errorPayload({
        code: "COMMIT_QUEUE_BROAD_ADD_BLOCKED",
        title: "Broad add blocked",
        detail:
          "Protected mode requires explicit file paths. Broad add commands are blocked.",
        context: {
          command: "add",
          args,
          repo,
          cwd: pathBaseCwd,
          session: session.id,
        },
        suggestions: [
          "Use `git add path/to/file` for each file you intend to commit.",
        ],
        retriable: true,
      }),
    );
  }

  const pathArgs = explicitPathArgs(args);
  if (pathArgs.length === 0) {
    fail(
      errorPayload({
        code: "COMMIT_QUEUE_EXPLICIT_PATH_REQUIRED",
        title: "Explicit path required",
        detail:
          "`git add` requires at least one explicit path in protected mode.",
        context: {
          command: "add",
          args,
          repo,
          cwd: pathBaseCwd,
          session: session.id,
        },
        suggestions: ["Use `git add path/to/file`."],
        retriable: true,
      }),
    );
  }

  const unsafePathspec = firstUnsafeAddPathspec(realGit, repo, pathArgs, {
    commandCwd,
    pathBaseCwd,
    globalArgs,
  });
  if (unsafePathspec) {
    fail(
      errorPayload({
        code: "COMMIT_QUEUE_BROAD_ADD_BLOCKED",
        title: "Broad add blocked",
        detail:
          "Protected mode requires explicit file paths. Directory, glob, and multi-file pathspecs are blocked.",
        context: {
          command: "add",
          args,
          repo,
          cwd: pathBaseCwd,
          session: session.id,
          unsafe_pathspec: unsafePathspec,
        },
        suggestions: [
          "Use `git add path/to/file` for each file you intend to commit.",
        ],
        retriable: true,
      }),
    );
  }

  const add = runGit(realGit, [...globalArgs, "add", ...args], {
    cwd: commandCwd,
    env: { GIT_INDEX_FILE: session.indexPath },
  });
  if (add.status !== 0) {
    if (isPathspecNotFound(add.stderr)) {
      fail(
        errorPayload({
          code: "COMMIT_QUEUE_PATHSPEC_NOT_FOUND",
          title: "Pathspec not found",
          detail:
            "Git could not find one or more explicit paths for protected staging.",
          context: {
            command: "add",
            args,
            pathspecs: pathArgs,
            repo,
            cwd: pathBaseCwd,
            session: session.id,
            git_stderr: add.stderr.trim(),
          },
          suggestions: [
            `Run \`git status --short -- ${formatPathspecsForCommand(pathArgs)}\` from the same directory to verify the path.`,
            "Retry `git add` from the directory where the path is valid, or pass paths relative to your current directory.",
            "Use one explicit file path per intended commit file; broad directories and globs stay blocked.",
          ],
          retriable: true,
        }),
      );
    }
    exitWithResult(add);
  }

  session.stagedPaths = recordStagedPaths(realGit, repo, session.indexPath);
  saveSession(session);
}

function recordStagedPaths(
  realGit: string,
  repo: string,
  indexPath: string,
): Record<string, StagedPath> {
  const staged: Record<string, StagedPath> = {};
  for (const relativePath of listStagedPaths(realGit, repo, indexPath)) {
    const blob = stagedBlob(realGit, repo, indexPath, relativePath);
    staged[relativePath] = {
      blob,
      addedAt: new Date().toISOString(),
    };
  }
  return staged;
}

function isPathspecNotFound(stderr: string): boolean {
  return /pathspec .* did not match any files/.test(stderr);
}

function formatPathspecsForCommand(pathspecs: string[]): string {
  return pathspecs.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
