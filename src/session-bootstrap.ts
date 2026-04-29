import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { currentHead, currentHeadRef, runGit } from "./git-runtime.js";
import {
  ensureStateDirs,
  saveActiveSessionMapping,
  sessionIndexPath,
  statePaths,
  writeJsonAtomic,
} from "./session-store.js";
import { exitWithResult } from "./errors.js";
import { timestampId } from "./text.js";
import type { AgentIdentity, CommitQueueSession } from "./types.js";

export function createCommitQueueSession(
  realGit: string,
  repo: string,
  agent: AgentIdentity,
): CommitQueueSession {
  const state = statePaths();
  ensureStateDirs(state);

  const id = `cq_${timestampId()}_${randomBytes(12).toString("hex")}`;
  const indexPath = sessionIndexPath(id);
  const head = currentHead(realGit, repo);
  const headRef = currentHeadRef(realGit, repo);

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
  saveActiveSessionMapping(repo, agent, id);
  return session;
}
