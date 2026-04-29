import * as path from "node:path";
import { detectAgentIdentity } from "./agent-identity.js";
import { errorPayload, fail } from "./errors.js";
import { createCommitQueueSession } from "./session-bootstrap.js";
import {
  loadActiveSessionMapping,
  loadSession,
  sessionIndexPath,
} from "./session-store.js";
import type {
  AgentIdentity,
  CommitQueueSession,
  ErrorPayload,
} from "./types.js";

export type RequireSessionOptions = {
  realGit?: string;
  autoBootstrap?: boolean;
};

export function requireSession(
  command: string,
  repo: string,
  options: RequireSessionOptions = {},
): CommitQueueSession {
  const id = process.env.COMMIT_QUEUE_ID;
  if (!id) {
    if (options.autoBootstrap && options.realGit) {
      return loadOrCreateActiveSession(command, repo, options.realGit);
    }
    fail(sessionRequiredError(command, repo));
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
    fail(
      errorPayload({
        code: "COMMIT_QUEUE_REPO_MISMATCH",
        title: "Session repository mismatch",
        detail: "COMMIT_QUEUE_ID belongs to a different repository.",
        context: {
          command,
          expected_repo: session.repo,
          actual_repo: repo,
          session: id,
        },
        suggestions: ['Run `eval "$(git getID)"` inside this repository.'],
        retriable: true,
      }),
    );
  }

  return session;
}

function loadOrCreateActiveSession(
  command: string,
  repo: string,
  realGit: string,
): CommitQueueSession {
  const agent = detectAgentIdentity(command, repo);
  const mapping = loadActiveSessionMapping(repo, agent);
  if (mapping) {
    const session = loadSession(mapping.sessionId);
    if (
      session &&
      activeSessionIsValid(session, mapping.sessionId, repo, agent)
    ) {
      return session;
    }
  }

  return createCommitQueueSession(realGit, repo, agent);
}

function activeSessionIsValid(
  session: CommitQueueSession,
  id: string,
  repo: string,
  agent: AgentIdentity,
): boolean {
  return (
    !sessionTamperReason(session, id) &&
    session.repo === repo &&
    session.agent?.name === agent.name &&
    session.agent?.sessionId === agent.sessionId
  );
}

function sessionRequiredError(command: string, repo: string): ErrorPayload {
  return errorPayload({
    code: "COMMIT_QUEUE_SESSION_REQUIRED",
    title: "Commit queue session required",
    detail: `Git command '${command}' is protected because you are sharing this checkout with other agents. Start a commit-queue session before staging or committing.`,
    context: { command, repo, cwd: process.cwd() },
    suggestions: [
      'Run `eval "$(git getID)"` from this repository, then retry.',
      "Use explicit paths for staging: `git add path/to/file`.",
    ],
    retriable: true,
  });
}

export function sessionMissingError(
  command: string,
  repo: string,
  id: string,
): ErrorPayload {
  return errorPayload({
    code: "COMMIT_QUEUE_SESSION_NOT_FOUND",
    title: "Commit queue session not found",
    detail: "COMMIT_QUEUE_ID does not map to an active session.",
    context: { command, repo, session: id },
    suggestions: ['Run `eval "$(git getID)"` to create a new session.'],
    retriable: true,
  });
}

function sessionTamperedError(
  command: string,
  repo: string,
  id: string,
  reason: Record<string, unknown>,
): ErrorPayload {
  return errorPayload({
    code: "COMMIT_QUEUE_SESSION_TAMPERED",
    title: "Commit queue session metadata changed",
    detail:
      "COMMIT_QUEUE_ID maps to session metadata that no longer matches its expected shape.",
    context: { command, repo, session: id, reason },
    suggestions: ['Run `eval "$(git getID)"` to create a fresh session.'],
    retriable: true,
  });
}

function sessionTamperReason(
  session: CommitQueueSession,
  id: string,
): Record<string, unknown> | null {
  if (session.id !== id) {
    return { field: "id", expected: id, actual: session.id };
  }

  const expectedIndexPath = sessionIndexPath(id);
  if (
    path.resolve(session.indexPath || "") !== path.resolve(expectedIndexPath)
  ) {
    return {
      field: "indexPath",
      expected: expectedIndexPath,
      actual: session.indexPath,
    };
  }

  return null;
}
