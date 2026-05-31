import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { AgentIdentity, CommitQueueSession } from "./types.js";

export type StatePaths = {
  root: string;
  sessions: string;
  indexes: string;
  locks: string;
  logs: string;
  staleInstalls: string;
  activeSessions: string;
};

export type ActiveSessionMapping = {
  repo: string;
  agent: AgentIdentity;
  sessionId: string;
  updatedAt: string;
};

export class CorruptStateFileError extends Error {
  constructor(
    readonly stateFile: string,
    readonly stateKind: "session" | "active-session",
  ) {
    super(`Corrupt commit-queue ${stateKind} state file`);
    this.name = "CorruptStateFileError";
  }
}

export function statePaths(): StatePaths {
  const root =
    process.env.COMMIT_QUEUE_STATE_DIR || path.join(homedir(), ".commit-queue");
  return {
    root,
    sessions: path.join(root, "sessions"),
    indexes: path.join(root, "indexes"),
    locks: path.join(root, "locks"),
    logs: path.join(root, "logs"),
    staleInstalls: path.join(root, "stale-installs"),
    activeSessions: path.join(root, "active-sessions"),
  };
}

export function sessionIndexPath(id: string): string {
  return path.join(statePaths().indexes, `${id}.index`);
}

export function ensureStateDirs(state = statePaths()): void {
  for (const dir of [
    state.root,
    state.sessions,
    state.indexes,
    state.locks,
    state.logs,
    state.staleInstalls,
    state.activeSessions,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadSession(id: string): CommitQueueSession | null {
  const sessionPath = path.join(statePaths().sessions, `${id}.json`);
  if (!existsSync(sessionPath)) return null;
  return readJsonState(sessionPath, "session") as CommitQueueSession;
}

export function saveSession(session: CommitQueueSession): void {
  ensureStateDirs();
  writeJsonAtomic(
    path.join(statePaths().sessions, `${session.id}.json`),
    session,
  );
}

export function loadActiveSessionMapping(
  repo: string,
  agent: AgentIdentity,
): ActiveSessionMapping | null {
  const mappingPath = activeSessionMappingPath(repo, agent);
  if (!existsSync(mappingPath)) return null;
  try {
    return readJsonState(mappingPath, "active-session") as ActiveSessionMapping;
  } catch (error) {
    if (error instanceof CorruptStateFileError) return null;
    throw error;
  }
}

export function saveActiveSessionMapping(
  repo: string,
  agent: AgentIdentity,
  sessionId: string,
): void {
  writeJsonAtomic(activeSessionMappingPath(repo, agent), {
    repo,
    agent,
    sessionId,
    updatedAt: new Date().toISOString(),
  } satisfies ActiveSessionMapping);
}

function activeSessionMappingPath(repo: string, agent: AgentIdentity): string {
  return path.join(
    statePaths().activeSessions,
    `${activeSessionKey(repo, agent)}.json`,
  );
}

function activeSessionKey(repo: string, agent: AgentIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify([repo, agent.name, agent.sessionId]))
    .digest("hex");
}

export function writeJsonAtomic(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, target);
}

function readJsonState(
  target: string,
  kind: CorruptStateFileError["stateKind"],
): unknown {
  try {
    return JSON.parse(readFileSync(target, "utf8"));
  } catch {
    throw new CorruptStateFileError(target, kind);
  }
}
