import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { GitResult, GitRunOptions, StagedPath } from "./types.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

export function runGit(
  realGit: string,
  args: string[],
  options: GitRunOptions = {},
): GitResult {
  return spawnSync(realGit, args, {
    cwd: options.cwd || process.cwd(),
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: "utf8",
  });
}

export function resolveRealGit(): string {
  if (process.env.COMMIT_QUEUE_REAL_GIT)
    return process.env.COMMIT_QUEUE_REAL_GIT;

  const shimPath = path.resolve(process.argv[1] || "");
  for (const candidate of [
    "/opt/homebrew/bin/git",
    "/usr/bin/git",
    ...whichAllGit(),
  ]) {
    const resolved = path.resolve(candidate);
    if (resolved === shimPath) continue;
    if (resolved.startsWith(projectRoot)) continue;
    const result = spawnSync(resolved, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return resolved;
  }

  return "git";
}

export function resolveRepo(
  realGit: string,
  globalArgs: string[] = [],
): string | null {
  const result = runGit(realGit, [
    ...globalArgs,
    "rev-parse",
    "--show-toplevel",
  ]);
  if (result.status !== 0) return null;
  return path.resolve(result.stdout.trim());
}

export function resolveGitPathBase(
  realGit: string,
  repo: string,
  globalArgs: string[] = [],
): string {
  const result = runGit(realGit, [...globalArgs, "rev-parse", "--show-prefix"]);
  if (result.status !== 0) return process.cwd();
  return path.join(repo, result.stdout.trim());
}

export function isRepoOptedOut(repo: string): boolean {
  const configPath = path.join(repo, ".commit-queue.json");
  if (!existsSync(configPath)) return false;

  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      enabled?: boolean;
    };
    return config.enabled === false;
  } catch {
    return false;
  }
}

export function currentHead(realGit: string, repo: string): string | null {
  const result = runGit(realGit, ["rev-parse", "--verify", "HEAD"], {
    cwd: repo,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

export function currentHeadRef(realGit: string, repo: string): string | null {
  const result = runGit(realGit, ["symbolic-ref", "-q", "HEAD"], { cwd: repo });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

export function listStagedPaths(
  realGit: string,
  repo: string,
  indexPath: string,
): string[] {
  const result = runGit(realGit, ["diff", "--cached", "--name-only", "-z"], {
    cwd: repo,
    env: { GIT_INDEX_FILE: indexPath },
  });
  if (result.status !== 0) return [];
  return parseGitNul(result.stdout);
}

export function listStagedPathsForPathspecs(
  realGit: string,
  repo: string,
  indexPath: string,
  pathspecs: string[],
  options: { cwd?: string; globalArgs?: string[] } = {},
): string[] {
  const result = runGit(
    realGit,
    [
      ...(options.globalArgs || []),
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--",
      ...pathspecs,
    ],
    {
      cwd: options.cwd || repo,
      env: { GIT_INDEX_FILE: indexPath },
    },
  );
  if (result.status !== 0) return [];
  return parseGitNul(result.stdout);
}

export function stagedEntry(
  realGit: string,
  repo: string,
  indexPath: string,
  relativePath: string,
): Pick<StagedPath, "blob" | "mode" | "status"> {
  const status = stagedPathStatus(realGit, repo, indexPath, relativePath);
  if (status === "deleted") return { blob: null, mode: null, status };

  const result = runGit(realGit, ["ls-files", "-s", "--", relativePath], {
    cwd: repo,
    env: { GIT_INDEX_FILE: indexPath },
  });
  const line = result.stdout.trim();
  if (result.status !== 0 || !line) return { blob: null, mode: null, status };

  const match = line.match(/^(\d{6})\s+([0-9a-f]{40})\s+\d+\t/);
  return {
    mode: match?.[1] ?? null,
    blob: match?.[2] ?? null,
    status,
  };
}

export function stagedBlob(
  realGit: string,
  repo: string,
  indexPath: string,
  relativePath: string,
): string | null {
  const result = runGit(realGit, ["ls-files", "-s", "--", relativePath], {
    cwd: repo,
    env: { GIT_INDEX_FILE: indexPath },
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout.trim().split(/\s+/)[1] || null;
}

export function worktreeEntry(
  _realGit: string,
  repo: string,
  relativePath: string,
): Pick<StagedPath, "blob" | "mode"> {
  const absolutePath = path.join(repo, relativePath);
  if (!existsSync(absolutePath)) return { blob: null, mode: null };

  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    return { mode: "120000", blob: gitBlobHash(readlinkSync(absolutePath)) };
  }

  if (stat.isFile()) {
    return {
      mode: stat.mode & 0o111 ? "100755" : "100644",
      blob: gitBlobHash(readFileSync(absolutePath)),
    };
  }

  return { blob: null, mode: null };
}

export function worktreeBlob(
  realGit: string,
  repo: string,
  relativePath: string,
): string | null {
  const absolutePath = path.join(repo, relativePath);
  if (!existsSync(absolutePath)) return null;
  const result = runGit(realGit, ["hash-object", "--", relativePath], {
    cwd: repo,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

export function matchingGitPaths(
  realGit: string,
  repo: string,
  pathspec: string,
  options: { cwd?: string; globalArgs?: string[] } = {},
): string[] {
  const result = runGit(
    realGit,
    [
      ...(options.globalArgs || []),
      "ls-files",
      "-z",
      "--full-name",
      "--cached",
      "--others",
      "--deleted",
      "--exclude-standard",
      "--",
      pathspec,
    ],
    { cwd: options.cwd || repo },
  );
  if (result.status !== 0) return [];
  return parseGitNul(result.stdout);
}

function parseGitLines(output: string): string[] {
  return [
    ...new Set(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

function parseGitNul(output: string): string[] {
  return [...new Set(output.split("\0").filter((entry) => entry.length > 0))];
}

function stagedPathStatus(
  realGit: string,
  repo: string,
  indexPath: string,
  relativePath: string,
): StagedPath["status"] {
  const result = runGit(
    realGit,
    ["diff", "--cached", "--name-status", "-z", "--", relativePath],
    {
      cwd: repo,
      env: { GIT_INDEX_FILE: indexPath },
    },
  );
  const [status] = parseGitNul(result.stdout);
  if (status === "D") return "deleted";
  if (status === "A") return "added";
  return "modified";
}

function gitBlobHash(content: string | Buffer): string {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function whichAllGit(): string[] {
  const which = spawnSync("/usr/bin/which", ["-a", "git"], {
    encoding: "utf8",
  });
  if (which.status !== 0) return [];
  return parseGitLines(which.stdout);
}
