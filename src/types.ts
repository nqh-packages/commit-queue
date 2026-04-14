import type { SpawnSyncReturns } from "node:child_process";

export type GitResult = SpawnSyncReturns<string>;

export type GitRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type GitRunner = (args: string[], options?: GitRunOptions) => GitResult;

export type Invocation = {
  globalArgs: string[];
  command: string | null;
  commandArgs: string[];
};

export type StagedPath = {
  blob: string | null;
  addedAt: string;
};

export type CommitQueueSession = {
  id: string;
  repo: string;
  head: string | null;
  headRef: string | null;
  indexPath: string;
  createdAt: string;
  stagedPaths: Record<string, StagedPath>;
};

export type ErrorPayload = {
  type: string;
  title: string;
  status: number;
  detail: string;
  error_code: string;
  timestamp: string;
  context: Record<string, unknown>;
  retriable: boolean;
  suggestions: string[];
};

export type LockOwner = {
  pid?: number;
  host?: string;
  repo?: string;
  startedAt?: string;
};

export type LockInfo = {
  exists: boolean;
  ageMs: number;
  owner: LockOwner | null;
  recovered?: boolean;
  reason?: string;
};
