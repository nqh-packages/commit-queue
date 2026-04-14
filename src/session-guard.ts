import * as path from "node:path";
import { errorPayload, fail } from "./errors.js";
import { loadSession, sessionIndexPath } from "./session-store.js";
import type { CommitQueueSession, ErrorPayload } from "./types.js";

export function requireSession(command: string, repo: string): CommitQueueSession {
  const id = process.env.COMMIT_QUEUE_ID;
  if (!id) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_SESSION_REQUIRED",
      title: "Commit queue session required",
      detail: `Mutating Git command '${command}' requires COMMIT_QUEUE_ID.`,
      context: { command, repo },
      suggestions: [
        "Run `eval \"$(git getID)\"` before mutating Git commands.",
        "Use explicit paths: `git add path/to/file`.",
      ],
      retriable: true,
    }));
  }

  const session = loadSession(id);
  if (!session) {
    fail(sessionMissingError(command, repo, id));
  }

  const tamperReason = sessionTamperReason(session, id);
  if (tamperReason) {
    fail(sessionTamperedError(command, repo, id, tamperReason));
  }

  if (session.repo !== repo) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_REPO_MISMATCH",
      title: "Session repository mismatch",
      detail: "COMMIT_QUEUE_ID belongs to a different repository.",
      context: { command, expected_repo: session.repo, actual_repo: repo, session: id },
      suggestions: ["Run `eval \"$(git getID)\"` inside this repository."],
      retriable: true,
    }));
  }

  return session;
}

export function sessionMissingError(command: string, repo: string, id: string): ErrorPayload {
  return errorPayload({
    code: "COMMIT_QUEUE_SESSION_NOT_FOUND",
    title: "Commit queue session not found",
    detail: "COMMIT_QUEUE_ID does not map to an active session.",
    context: { command, repo, session: id },
    suggestions: ["Run `eval \"$(git getID)\"` to create a new session."],
    retriable: true,
  });
}

function sessionTamperedError(command: string, repo: string, id: string, reason: Record<string, unknown>): ErrorPayload {
  return errorPayload({
    code: "COMMIT_QUEUE_SESSION_TAMPERED",
    title: "Commit queue session metadata changed",
    detail: "COMMIT_QUEUE_ID maps to session metadata that no longer matches its expected shape.",
    context: { command, repo, session: id, reason },
    suggestions: ["Run `eval \"$(git getID)\"` to create a fresh session."],
    retriable: true,
  });
}

function sessionTamperReason(session: CommitQueueSession, id: string): Record<string, unknown> | null {
  if (session.id !== id) {
    return { field: "id", expected: id, actual: session.id };
  }

  const expectedIndexPath = sessionIndexPath(id);
  if (path.resolve(session.indexPath || "") !== path.resolve(expectedIndexPath)) {
    return { field: "indexPath", expected: expectedIndexPath, actual: session.indexPath };
  }

  return null;
}
