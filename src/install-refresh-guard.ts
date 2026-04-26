import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { errorPayload, fail } from "./errors.js";
import { statePaths } from "./session-store.js";
import { hash } from "./text.js";

export function assertNoFailedInstallRefresh(
  command: string,
  repo: string,
): void {
  const markerPath = failedInstallRefreshPath(repo);
  if (!existsSync(markerPath)) return;

  fail(
    errorPayload({
      code: "COMMIT_QUEUE_INSTALL_REFRESH_FAILED",
      title: "Installed commit-queue runtime is stale",
      detail:
        "The last commit-queue runtime refresh failed after this repository changed. Protected mutations are blocked until the installed shim refreshes successfully.",
      context: {
        command,
        repo,
        marker: markerPath,
        refresh_failure: readFailedRefreshMarker(markerPath),
      },
      suggestions: [
        "Fix the failed committed source or switch to a commit where the refresh hook succeeds.",
        "Run `npm run install:local` from the commit-queue repository after fixing the refresh failure.",
      ],
      retriable: true,
    }),
  );
}

export function failedInstallRefreshPath(repo: string): string {
  return path.join(
    statePaths().staleInstalls,
    `${hash(path.resolve(repo))}.json`,
  );
}

function readFailedRefreshMarker(markerPath: string): unknown {
  try {
    return JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return { unreadable_marker: true };
  }
}
