import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import * as path from "node:path";
import { errorPayload, fail } from "./errors.js";
import {
  ensureStateDirs,
  statePaths,
  writeJsonAtomic,
} from "./session-store.js";
import { hash } from "./text.js";
import type { LockInfo, LockOwner } from "./types.js";

const LOCK_TIMEOUT_MS = 5000;
const ORPHAN_LOCK_GRACE_MS = 5000;
const HARD_STALE_LOCK_MS = 30 * 60 * 1000;

export function withRepoLock(repo: string, fn: () => void): void {
  const state = statePaths();
  ensureStateDirs(state);
  const lockPath = path.join(state.locks, `${hash(repo)}.lock`);
  const started = Date.now();
  let currentLock: LockInfo | null = null;

  while (true) {
    try {
      mkdirSync(lockPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      currentLock = recoverLock(lockPath);
      if (currentLock.recovered) continue;

      if (Date.now() - started > lockTimeoutMs()) {
        fail(
          errorPayload({
            code: "COMMIT_QUEUE_REPO_LOCK_TIMEOUT",
            title: "Repository lock timeout",
            detail: "Could not acquire the commit lock for this repository.",
            context: {
              repo,
              lock: lockPath,
              lock_owner: currentLock.owner,
              lock_age_ms: currentLock.ageMs,
            },
            suggestions: lockTimeoutSuggestions(currentLock),
            retriable: true,
          }),
        );
      }
      sleep(50);
      continue;
    }

    try {
      writeLockMetadata(lockPath, repo);
      break;
    } catch (error) {
      rmSync(lockPath, { recursive: true, force: true });
      throw error;
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    rmSync(lockPath, { recursive: true, force: true });
  };

  process.once("exit", release);
  try {
    fn();
  } finally {
    process.removeListener("exit", release);
    release();
  }
}

function writeLockMetadata(lockPath: string, repo: string): void {
  writeJsonAtomic(path.join(lockPath, "owner.json"), {
    pid: process.pid,
    host: hostname(),
    repo,
    startedAt: new Date().toISOString(),
  });
}

function recoverLock(lockPath: string): LockInfo {
  const info = readLockInfo(lockPath);
  if (!info.exists) return { recovered: true, reason: "missing", ...info };

  if (info.ageMs > HARD_STALE_LOCK_MS) {
    rmSync(lockPath, { recursive: true, force: true });
    return { ...info, recovered: true, reason: "stale" };
  }

  if (!info.owner) {
    if (info.ageMs > ORPHAN_LOCK_GRACE_MS) {
      rmSync(lockPath, { recursive: true, force: true });
      return { ...info, recovered: true, reason: "orphan" };
    }
    return { ...info, recovered: false, reason: "orphan_grace" };
  }

  if (lockOwnerIsGone(info.owner)) {
    rmSync(lockPath, { recursive: true, force: true });
    return { ...info, recovered: true, reason: "dead_owner" };
  }

  return { ...info, recovered: false, reason: "active_owner" };
}

function readLockInfo(lockPath: string): LockInfo {
  try {
    const stat = statSync(lockPath);
    return {
      exists: true,
      ageMs: Date.now() - stat.mtimeMs,
      owner: readLockOwner(lockPath),
    };
  } catch {
    return { exists: false, ageMs: 0, owner: null };
  }
}

function readLockOwner(lockPath: string): LockOwner | null {
  try {
    return JSON.parse(
      readFileSync(path.join(lockPath, "owner.json"), "utf8"),
    ) as LockOwner;
  } catch {
    return null;
  }
}

function lockOwnerIsGone(owner: LockOwner): boolean {
  if (!Number.isInteger(owner.pid) || (owner.pid ?? 0) <= 0) return false;
  if (owner.host && owner.host !== hostname()) return false;

  try {
    process.kill(owner.pid ?? 0, 0);
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === "ESRCH";
  }
}

function lockTimeoutSuggestions(lockInfo: LockInfo): string[] {
  const suggestions = ["Retry the commit after the active commit finishes."];
  if (lockInfo.owner?.pid) {
    suggestions.push(`Active lock owner pid: ${lockInfo.owner.pid}.`);
  }
  suggestions.push(`Lock age: ${Math.round(lockInfo.ageMs)}ms.`);
  return suggestions;
}

function lockTimeoutMs(): number {
  return (
    Number.parseInt(process.env.COMMIT_QUEUE_LOCK_TIMEOUT_MS || "", 10) ||
    LOCK_TIMEOUT_MS
  );
}

function sleep(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Math.max(1, until - Date.now()),
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
