import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { detectAgentIdentity } from "../agent-identity.js";
import { exitWithResult } from "../errors.js";
import { currentHead, currentHeadRef, runGit } from "../git-runtime.js";
import {
  ensureStateDirs,
  sessionIndexPath,
  statePaths,
  writeJsonAtomic,
} from "../session-store.js";
import { escapeDoubleQuoted, timestampId } from "../text.js";
import type { CommitQueueSession } from "../types.js";

export function createSession(realGit: string, repo: string): void {
  const state = statePaths();
  ensureStateDirs(state);

  const id = `cq_${timestampId()}_${randomBytes(12).toString("hex")}`;
  const indexPath = sessionIndexPath(id);
  const head = currentHead(realGit, repo);
  const headRef = currentHeadRef(realGit, repo);
  const agent = detectAgentIdentity("getID", repo);

  if (head) {
    const readTree = runGit(realGit, ["read-tree", head], {
      cwd: repo,
      env: { GIT_INDEX_FILE: indexPath },
    });
    if (readTree.status !== 0) {
      exitWithResult(readTree);
    }
  }

  const session: CommitQueueSession = {
    id,
    repo,
    head,
    headRef,
    indexPath,
    createdAt: new Date().toISOString(),
    agent,
    stagedPaths: {},
  };
  writeJsonAtomic(path.join(state.sessions, `${id}.json`), session);

  process.stdout.write(
    [
      `export COMMIT_QUEUE_ID="${escapeDoubleQuoted(id)}"`,
      `export COMMIT_QUEUE_REPO="${escapeDoubleQuoted(repo)}"`,
      `export COMMIT_QUEUE_AGENT="${escapeDoubleQuoted(agent.name)}"`,
      `export COMMIT_QUEUE_AGENT_SESSION="${escapeDoubleQuoted(agent.sessionId)}"`,
      "",
    ].join("\n"),
  );
}
