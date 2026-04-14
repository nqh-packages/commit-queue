import { explicitPathArgs, firstUnsafeAddPathspec, hasBroadAdd } from "../command-policy.js";
import { errorPayload, exitWithResult, fail } from "../errors.js";
import { listStagedPaths, runGit, stagedBlob } from "../git-runtime.js";
import { requireSession } from "../session-guard.js";
import { saveSession } from "../session-store.js";
import type { StagedPath } from "../types.js";

export function handleAdd(realGit: string, repo: string, args: string[]): void {
  const session = requireSession("add", repo);

  if (hasBroadAdd(args)) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_BROAD_ADD_BLOCKED",
      title: "Broad add blocked",
      detail: "Protected mode requires explicit file paths. Broad add commands are blocked.",
      context: { command: "add", args, repo, session: session.id },
      suggestions: ["Use `git add path/to/file` for each file you intend to commit."],
      retriable: true,
    }));
  }

  const pathArgs = explicitPathArgs(args);
  if (pathArgs.length === 0) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_EXPLICIT_PATH_REQUIRED",
      title: "Explicit path required",
      detail: "`git add` requires at least one explicit path in protected mode.",
      context: { command: "add", args, repo, session: session.id },
      suggestions: ["Use `git add path/to/file`."],
      retriable: true,
    }));
  }

  const unsafePathspec = firstUnsafeAddPathspec(realGit, repo, pathArgs);
  if (unsafePathspec) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_BROAD_ADD_BLOCKED",
      title: "Broad add blocked",
      detail: "Protected mode requires explicit file paths. Directory, glob, and multi-file pathspecs are blocked.",
      context: { command: "add", args, repo, session: session.id, unsafe_pathspec: unsafePathspec },
      suggestions: ["Use `git add path/to/file` for each file you intend to commit."],
      retriable: true,
    }));
  }

  const add = runGit(realGit, ["add", ...args], {
    cwd: repo,
    env: { GIT_INDEX_FILE: session.indexPath },
  });
  if (add.status !== 0) {
    exitWithResult(add);
  }

  session.stagedPaths = recordStagedPaths(realGit, repo, session.indexPath);
  saveSession(session);
}

function recordStagedPaths(realGit: string, repo: string, indexPath: string): Record<string, StagedPath> {
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
