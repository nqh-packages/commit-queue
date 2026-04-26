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
const RECOVERED_LOCK_REASONS = new Set<LockRecoveryReason>([
  "missing",
  "stale",
  "orphan",
  "dead_owner",
]);

type LockRecoveryReason = NonNullable<LockInfo["reason"]>;

export function withRepoLock(repo: string, fn: () => void): void {
  const state = statePaths();
  ensureStateDirs(state);
  const lockPath = path.join(state.locks, `${hash(repo)}.lock`);
  acquireLock(lockPath, repo);

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

function acquireLock(lockPath: string, repo: string): void {
  const started = Date.now();

  while (true) {
    const lock = tryCreateLock(lockPath, repo);
    if (lock === "acquired") return;
    if (lock.recovered) continue;
    if (Date.now() - started > lockTimeoutMs()) {
      failLockTimeout(repo, lockPath, lock);
    }
    sleep(50);
  }
}

function tryCreateLock(lockPath: string, repo: string): "acquired" | LockInfo {
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    return recoverLock(lockPath);
  }

  try {
    writeLockMetadata(lockPath, repo);
    return "acquired";
  } catch (error) {
    rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
}

function failLockTimeout(
  repo: string,
  lockPath: string,
  lockInfo: LockInfo,
): void {
  fail(
    errorPayload({
      code: "COMMIT_QUEUE_REPO_LOCK_TIMEOUT",
      title: "Repository lock timeout",
      detail: "Could not acquire the commit lock for this repository.",
      context: {
        repo,
        lock: lockPath,
        lock_owner: lockInfo.owner,
        lock_age_ms: lockInfo.ageMs,
      },
      suggestions: lockTimeoutSuggestions(lockInfo),
      retriable: true,
    }),
  );
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
  const reason = lockRecoveryReason(info);
  if (reason === "stale" || reason === "orphan" || reason === "dead_owner") {
    rmSync(lockPath, { recursive: true, force: true });
  }
  return {
    ...info,
    recovered: RECOVERED_LOCK_REASONS.has(reason),
    reason,
  };
}

function lockRecoveryReason(info: LockInfo): LockRecoveryReason {
  if (!info.exists) return "missing";
  if (info.ageMs > HARD_STALE_LOCK_MS) return "stale";

  if (!info.owner) {
    return info.ageMs > ORPHAN_LOCK_GRACE_MS ? "orphan" : "orphan_grace";
  }

  return lockOwnerIsGone(info.owner) ? "dead_owner" : "active_owner";
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
