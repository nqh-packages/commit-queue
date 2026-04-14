import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BLOCKED_COMMANDS = new Map([
  ["checkout", "COMMIT_QUEUE_SHARED_TREE_MUTATION_BLOCKED"],
  ["switch", "COMMIT_QUEUE_SHARED_TREE_MUTATION_BLOCKED"],
  ["reset", "COMMIT_QUEUE_SHARED_TREE_MUTATION_BLOCKED"],
  ["restore", "COMMIT_QUEUE_SHARED_TREE_MUTATION_BLOCKED"],
  ["merge", "COMMIT_QUEUE_HISTORY_MUTATION_BLOCKED"],
  ["rebase", "COMMIT_QUEUE_HISTORY_MUTATION_BLOCKED"],
  ["pull", "COMMIT_QUEUE_HISTORY_MUTATION_BLOCKED"],
  ["stash", "COMMIT_QUEUE_SHARED_TREE_MUTATION_BLOCKED"],
]);

const READ_ONLY_COMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "help",
  "--help",
  "-h",
  "--version",
  "version",
]);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

export function runProtectedGit(args) {
  const realGit = resolveRealGit();

  if (process.env.COMMIT_QUEUE_BYPASS === "1") {
    exitWithResult(runGit(realGit, args, { stdio: "pipe" }));
    return;
  }

  const command = args[0];
  if (!command) {
    exitWithResult(runGit(realGit, args, { stdio: "pipe" }));
    return;
  }

  const repo = resolveRepo(realGit);
  if (!repo) {
    if (command === "getID") {
      fail(errorPayload({
        code: "COMMIT_QUEUE_NOT_IN_REPO",
        title: "Not inside a Git repository",
        detail: "`git getID` must be run inside a Git repository.",
        context: { command },
        suggestions: ["Run `git getID` from inside the repository you want to protect."],
        retriable: true,
      }));
      return;
    }
    exitWithResult(runGit(realGit, args, { stdio: "pipe" }));
    return;
  }

  if (isRepoOptedOut(repo)) {
    exitWithResult(runGit(realGit, args, { stdio: "pipe" }));
    return;
  }

  if (command === "getID") {
    createSession(realGit, repo);
    return;
  }

  if (isReadOnlyCommand(command, args)) {
    exitWithResult(runGit(realGit, args, { stdio: "pipe" }));
    return;
  }

  if (BLOCKED_COMMANDS.has(command)) {
    fail(errorPayload({
      code: BLOCKED_COMMANDS.get(command),
      title: "Shared working tree mutation blocked",
      detail: `Git command '${command}' is blocked in protected mode.`,
      context: { command, repo },
      suggestions: [
        "Use a commit-queue session for `git add path` and `git commit -m`.",
        "Avoid commands that mutate the shared working tree while agents are active.",
      ],
      retriable: false,
    }));
    return;
  }

  if (command === "add") {
    handleAdd(realGit, repo, args.slice(1));
    return;
  }

  if (command === "commit") {
    handleCommit(realGit, repo, args.slice(1));
    return;
  }

  requireSession(command, repo);
}

export function runHumanGit(args) {
  exitWithResult(runGit(resolveRealGit(), args, { stdio: "pipe" }));
}

function createSession(realGit, repo) {
  const state = statePaths();
  ensureStateDirs(state);

  const id = `cq_${timestampId()}_${randomBytes(3).toString("hex")}`;
  const indexPath = path.join(state.indexes, `${id}.index`);
  const head = currentHead(realGit, repo);

  if (head) {
    const readTree = runGit(realGit, ["read-tree", head], {
      cwd: repo,
      env: { GIT_INDEX_FILE: indexPath },
    });
    if (readTree.status !== 0) {
      exitWithResult(readTree);
      return;
    }
  }

  const session = {
    id,
    repo,
    head,
    indexPath,
    createdAt: new Date().toISOString(),
    stagedPaths: {},
  };
  writeJsonAtomic(path.join(state.sessions, `${id}.json`), session);

  process.stdout.write([
    `export COMMIT_QUEUE_ID="${escapeDoubleQuoted(id)}"`,
    `export COMMIT_QUEUE_REPO="${escapeDoubleQuoted(repo)}"`,
    "",
  ].join("\n"));
}

function handleAdd(realGit, repo, args) {
  const session = requireSession("add", repo);
  if (!session) return;

  if (hasBroadAdd(args)) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_BROAD_ADD_BLOCKED",
      title: "Broad add blocked",
      detail: "Protected mode requires explicit file paths. Broad add commands are blocked.",
      context: { command: "add", args, repo, session: session.id },
      suggestions: ["Use `git add path/to/file` for each file you intend to commit."],
      retriable: true,
    }));
    return;
  }

  const pathArgs = explicitPathArgs(args);
  if (pathArgs.length === 0) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_EXPLICIT_PATH_REQUIRED",
      title: "Explicit path required",
      detail: "`git add` requires at least one explicit path in protected mode.",
      context: { command: "add", args, repo, session: session.id },
      suggestions: ["Use `git add path/to/file`."],
      retriable: true,
    }));
    return;
  }

  const add = runGit(realGit, ["add", ...args], {
    cwd: repo,
    env: { GIT_INDEX_FILE: session.indexPath },
  });
  if (add.status !== 0) {
    exitWithResult(add);
    return;
  }

  const stagedPaths = listStagedPaths(realGit, repo, session.indexPath);
  const staged = {};
  for (const relativePath of stagedPaths) {
    const blob = stagedBlob(realGit, repo, session.indexPath, relativePath);
    if (blob) {
      staged[relativePath] = {
        blob,
        addedAt: new Date().toISOString(),
      };
    }
  }

  session.stagedPaths = staged;
  saveSession(session);
}

function handleCommit(realGit, repo, args) {
  const session = requireSession("commit", repo);
  if (!session) return;

  if (args.includes("-a") || args.includes("--all")) {
    fail(errorPayload({
      code: "COMMIT_QUEUE_COMMIT_ALL_BLOCKED",
      title: "Commit all blocked",
      detail: "`git commit -a` bypasses explicit protected staging.",
      context: { command: "commit", args, repo, session: session.id },
      suggestions: ["Use `git add path/to/file`, then `git commit -m \"message\"`."],
      retriable: true,
    }));
    return;
  }

  withRepoLock(repo, () => {
    const freshSession = loadSession(session.id);
    if (!freshSession) {
      fail(sessionMissingError("commit", repo, session.id));
      return;
    }

    const head = currentHead(realGit, repo);
    if (head !== freshSession.head) {
      fail(errorPayload({
        code: "COMMIT_QUEUE_HEAD_DRIFT",
        title: "Repository HEAD changed",
        detail: "The repository HEAD changed after this session started.",
        context: {
          command: "commit",
          repo,
          session: freshSession.id,
          expected_head: freshSession.head,
          actual_head: head,
        },
        suggestions: [
          "Run `eval \"$(git getID)\"` to start a fresh session from the current HEAD.",
          "Stage the intended files again before committing.",
        ],
        retriable: true,
      }));
      return;
    }

    const stagedPaths = listStagedPaths(realGit, repo, freshSession.indexPath);
    if (stagedPaths.length === 0) {
      fail(errorPayload({
        code: "COMMIT_QUEUE_NOTHING_STAGED",
        title: "Nothing staged",
        detail: "This commit-queue session has no staged paths.",
        context: { command: "commit", repo, session: freshSession.id },
        suggestions: ["Use `git add path/to/file` before committing."],
        retriable: true,
      }));
      return;
    }

    const recordedPaths = Object.keys(freshSession.stagedPaths || {}).sort();
    if (JSON.stringify([...stagedPaths].sort()) !== JSON.stringify(recordedPaths)) {
      fail(errorPayload({
        code: "COMMIT_QUEUE_STAGED_PATH_MISMATCH",
        title: "Staged path set changed",
        detail: "The session index no longer matches the recorded staged path set.",
        context: { command: "commit", repo, session: freshSession.id, staged_paths: stagedPaths, recorded_paths: recordedPaths },
        suggestions: ["Run `git add path/to/file` again for the intended files."],
        retriable: true,
      }));
      return;
    }

    for (const relativePath of stagedPaths) {
      const expected = freshSession.stagedPaths[relativePath]?.blob;
      const actual = worktreeBlob(realGit, repo, relativePath);
      if (!expected || actual !== expected) {
        fail(errorPayload({
          code: "COMMIT_QUEUE_FILE_DRIFT",
          title: "Staged file changed before commit",
          detail: "A staged file changed after this session staged it.",
          context: {
            command: "commit",
            repo,
            session: freshSession.id,
            path: relativePath,
            expected_blob: expected,
            actual_blob: actual,
          },
          suggestions: [`Run \`git add ${relativePath}\` again if this content is intentional.`],
          retriable: true,
        }));
        return;
      }
    }

    const commit = runGit(realGit, ["commit", ...args], {
      cwd: repo,
      env: { GIT_INDEX_FILE: freshSession.indexPath },
    });
    if (commit.status !== 0) {
      exitWithResult(commit);
      return;
    }

    runGit(realGit, ["reset", "-q", "--mixed", "HEAD"], { cwd: repo });

    freshSession.head = currentHead(realGit, repo);
    freshSession.stagedPaths = {};
    saveSession(freshSession);
    exitWithResult(commit);
  });
}

function requireSession(command, repo) {
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
    return null;
  }

  const session = loadSession(id);
  if (!session) {
    fail(sessionMissingError(command, repo, id));
    return null;
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
    return null;
  }

  return session;
}

function sessionMissingError(command, repo, id) {
  return errorPayload({
    code: "COMMIT_QUEUE_SESSION_NOT_FOUND",
    title: "Commit queue session not found",
    detail: "COMMIT_QUEUE_ID does not map to an active session.",
    context: { command, repo, session: id },
    suggestions: ["Run `eval \"$(git getID)\"` to create a new session."],
    retriable: true,
  });
}

function hasBroadAdd(args) {
  return args.some((arg) => (
    arg === "." ||
    arg === ":/" ||
    arg === "-A" ||
    arg === "--all" ||
    arg === "-u" ||
    arg === "--update" ||
    arg.startsWith("-A") ||
    arg.startsWith("-u")
  ));
}

function explicitPathArgs(args) {
  return args.filter((arg) => arg !== "--" && !arg.startsWith("-"));
}

function isReadOnlyCommand(command, args) {
  if (READ_ONLY_COMMANDS.has(command)) return true;
  if (command === "branch") {
    return !args.some((arg) => ["-d", "-D", "-m", "-M", "--delete", "--move", "--set-upstream-to"].includes(arg));
  }
  return false;
}

function resolveRepo(realGit) {
  const result = runGit(realGit, ["rev-parse", "--show-toplevel"], { stdio: "pipe" });
  if (result.status !== 0) return null;
  return path.resolve(result.stdout.trim());
}

function isRepoOptedOut(repo) {
  const configPath = path.join(repo, ".commit-queue.json");
  if (!existsSync(configPath)) return false;

  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    return config.enabled === false;
  } catch {
    return false;
  }
}

function currentHead(realGit, repo) {
  const result = runGit(realGit, ["rev-parse", "--verify", "HEAD"], { cwd: repo });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function listStagedPaths(realGit, repo, indexPath) {
  const result = runGit(realGit, ["diff", "--cached", "--name-only"], {
    cwd: repo,
    env: { GIT_INDEX_FILE: indexPath },
  });
  if (result.status !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function stagedBlob(realGit, repo, indexPath, relativePath) {
  const result = runGit(realGit, ["ls-files", "-s", "--", relativePath], {
    cwd: repo,
    env: { GIT_INDEX_FILE: indexPath },
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout.trim().split(/\s+/)[1] || null;
}

function worktreeBlob(realGit, repo, relativePath) {
  const absolutePath = path.join(repo, relativePath);
  if (!existsSync(absolutePath)) return null;
  const result = runGit(realGit, ["hash-object", "--", relativePath], { cwd: repo });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function statePaths() {
  const root = process.env.COMMIT_QUEUE_STATE_DIR || path.join(homedir(), ".commit-queue");
  return {
    root,
    sessions: path.join(root, "sessions"),
    indexes: path.join(root, "indexes"),
    locks: path.join(root, "locks"),
    logs: path.join(root, "logs"),
  };
}

function ensureStateDirs(state = statePaths()) {
  for (const dir of [state.root, state.sessions, state.indexes, state.locks, state.logs]) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadSession(id) {
  const sessionPath = path.join(statePaths().sessions, `${id}.json`);
  if (!existsSync(sessionPath)) return null;
  return JSON.parse(readFileSync(sessionPath, "utf8"));
}

function saveSession(session) {
  ensureStateDirs();
  writeJsonAtomic(path.join(statePaths().sessions, `${session.id}.json`), session);
}

function writeJsonAtomic(target, value) {
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, target);
}

function withRepoLock(repo, fn) {
  const state = statePaths();
  ensureStateDirs(state);
  const lockPath = path.join(state.locks, `${hash(repo)}.lock`);
  const started = Date.now();

  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      clearStaleLock(lockPath);
      if (Date.now() - started > 5000) {
        fail(errorPayload({
          code: "COMMIT_QUEUE_REPO_LOCK_TIMEOUT",
          title: "Repository lock timeout",
          detail: "Could not acquire the commit lock for this repository.",
          context: { repo, lock: lockPath },
          suggestions: ["Retry the commit after the active commit finishes."],
          retriable: true,
        }));
        return;
      }
      sleep(50);
    }
  }

  try {
    fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function clearStaleLock(lockPath) {
  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs > 30 * 60 * 1000) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  } catch {
    return;
  }
}

function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, until - Date.now()));
  }
}

function runGit(realGit, args, options = {}) {
  return spawnSync(realGit, args, {
    cwd: options.cwd || process.cwd(),
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    encoding: "utf8",
  });
}

function exitWithResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

function fail(payload) {
  if (process.env.COMMIT_QUEUE_JSON === "1") {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write([
      `[commit-queue] blocked: ${payload.detail}`,
      "",
      `error_code: ${payload.error_code}`,
      ...payload.suggestions.map((suggestion) => `suggestion: ${suggestion}`),
      "",
    ].join("\n"));
  }
  process.exit(payload.status >= 500 ? 1 : 2);
}

function errorPayload({ code, title, detail, context, suggestions, retriable }) {
  return {
    type: `https://commit-queue.local/errors/${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status: 409,
    detail,
    error_code: code,
    timestamp: new Date().toISOString(),
    context,
    retriable,
    suggestions,
  };
}

function resolveRealGit() {
  if (process.env.COMMIT_QUEUE_REAL_GIT) return process.env.COMMIT_QUEUE_REAL_GIT;

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

function whichAllGit() {
  const which = spawnSync("/usr/bin/which", ["-a", "git"], { encoding: "utf8" });
  if (which.status !== 0) return [];
  return which.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function timestampId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function escapeDoubleQuoted(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("$", "\\$").replaceAll("`", "\\`").replaceAll('"', '\\"');
}
