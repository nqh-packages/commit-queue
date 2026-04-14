import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { CommitQueueSession } from "./types.js";

export type StatePaths = {
  root: string;
  sessions: string;
  indexes: string;
  locks: string;
  logs: string;
};

export function statePaths(): StatePaths {
  const root = process.env.COMMIT_QUEUE_STATE_DIR || path.join(homedir(), ".commit-queue");
  return {
    root,
    sessions: path.join(root, "sessions"),
    indexes: path.join(root, "indexes"),
    locks: path.join(root, "locks"),
    logs: path.join(root, "logs"),
  };
}

export function sessionIndexPath(id: string): string {
  return path.join(statePaths().indexes, `${id}.index`);
}

export function ensureStateDirs(state = statePaths()): void {
  for (const dir of [state.root, state.sessions, state.indexes, state.locks, state.logs]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadSession(id: string): CommitQueueSession | null {
  const sessionPath = path.join(statePaths().sessions, `${id}.json`);
  if (!existsSync(sessionPath)) return null;
  return JSON.parse(readFileSync(sessionPath, "utf8")) as CommitQueueSession;
}

export function saveSession(session: CommitQueueSession): void {
  ensureStateDirs();
  writeJsonAtomic(path.join(statePaths().sessions, `${session.id}.json`), session);
}

export function writeJsonAtomic(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, target);
}
