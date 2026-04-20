# AGENTS.md

## Mission

Build `commit-queue`: a small local Git safety shim for AI-agent-heavy development.

| Priority | Rule |
|----------|------|
| 1 | Preserve real Git behavior for read-only commands |
| 2 | Block unsafe agent mutations before they touch shared Git state |
| 3 | Keep v1 small: no daemon, no server, no filesystem watcher |
| 4 | Make errors actionable for AI agents |
| 5 | Keep human escape interactive and out of agent-facing output |

## Product Contract

Read [VISION.md](./VISION.md) before changing behavior.

### Locked v1 Decisions

| Area | Decision |
|------|----------|
| Name | `commit-queue` |
| Protected command | `git` |
| Human/raw command | Not documented for agents |
| Default scope | Enabled for all Git repos |
| Opt-out file | `.commit-queue.json` with `{ "enabled": false }` |
| Session command | `eval "$(git getID)"` |
| Session env vars | `COMMIT_QUEUE_ID`, `COMMIT_QUEUE_REPO`, `COMMIT_QUEUE_AGENT`, `COMMIT_QUEUE_AGENT_SESSION` |
| Agent attribution | `git getID` requires identity from the adapter registry or explicit env vars |
| Commit trailers | Protected commits append `Commit-Queue-Session`, `Coding-Agent`, and `Coding-Agent-Session` |
| Staging | Explicit paths only |
| Index isolation | `GIT_INDEX_FILE` per session |
| Commit safety | Per-repo lock, drift check, HEAD check |
| Runtime state | `~/.commit-queue/` |

## Non-Negotiables

| Rule | Reason |
|------|--------|
| Do not replace `/usr/bin/git` | User-level PATH shim only |
| Do not mention the human bypass command in agent-facing errors | Bypass is for humans/operators |
| Do not allow `git add .` in v1 | Broad add can capture unrelated changes |
| Do not allow `git commit -a` in v1 | It bypasses explicit staging |
| Do not implement a daemon in v1 | Adds lifecycle and debugging cost |
| Do not use filesystem watchers in v1 | Drift check is commit-time only |
| Do not auto-merge conflicts | Ambiguous content must block |
| Do not delete `~/.commit-queue/` state by hand | Locks self-heal; manual deletion can break active commits |
| Do not add runtime dependencies without approval | Tool must stay tiny and shareable |

## Command Policy

### Pass Through Without Session

| Command | Notes |
|---------|-------|
| Non-owned Git commands | Pass through to real Git |
| Examples | `status`, `diff`, `log`, `show`, `clone`, `fetch`, `tag`, `branch`, `push`, `config`, `checkout`, future Git commands |

### Protected Commands

| Command | Required Behavior |
|---------|-------------------|
| `git getID` | Create session, print shell exports |
| `git add path` | Require session, explicit paths only, stage into session index |
| `git commit -m "..."` | Require session, lock repo, verify drift, append attribution trailers, commit |

### Blocked In Protected Add/Commit Flow

| Command | Error Code |
|---------|------------|
| `git add .` | `COMMIT_QUEUE_BROAD_ADD_BLOCKED` |
| `git add -A` | `COMMIT_QUEUE_BROAD_ADD_BLOCKED` |
| `git add -u` | `COMMIT_QUEUE_BROAD_ADD_BLOCKED` |
| `git add dir/` | `COMMIT_QUEUE_BROAD_ADD_BLOCKED` |
| `git add "*.ts"` | `COMMIT_QUEUE_BROAD_ADD_BLOCKED` |
| `git add --pathspec-from-file` | `COMMIT_QUEUE_BROAD_ADD_BLOCKED` |
| `git commit -a` | `COMMIT_QUEUE_COMMIT_ALL_BLOCKED` |
| `git commit --no-verify` | `COMMIT_QUEUE_NO_VERIFY_BLOCKED` |
| `git commit --amend` | `COMMIT_QUEUE_AMEND_BLOCKED` |
| `git commit path/to/file` | `COMMIT_QUEUE_COMMIT_PATHSPEC_BLOCKED` |
| `git -c ... commit` | `COMMIT_QUEUE_UNSAFE_CONFIG_OVERRIDE` |
| `git commit --trailer "Coding-Agent: ..."` | `COMMIT_QUEUE_RESERVED_TRAILER_BLOCKED` |
| `git getID` without agent identity | `COMMIT_QUEUE_AGENT_ID_REQUIRED` |

## Error Rules

Use structured, agent-recoverable errors.

| Field | Required |
|-------|----------|
| `error_code` | Yes |
| `detail` | Yes |
| `context` | Yes |
| `suggestions` | Yes |
| `retriable` | Yes |

### Agent-Facing Error Example

```json
{
  "error_code": "COMMIT_QUEUE_SESSION_REQUIRED",
  "detail": "Git command 'add' is protected because you are sharing this checkout with other agents. Start a commit-queue session before staging or committing.",
  "context": {
    "command": "add",
    "repo": "/repo"
  },
  "retriable": true,
  "suggestions": [
    "Run `eval \"$(git getID)\"` from this repository, then retry.",
    "Use explicit paths for staging: `git add path/to/file`."
  ]
}
```

### Forbidden Error Content

| Do Not Include | Reason |
|----------------|--------|
| Human bypass instructions | Agents should not learn bypass route |
| Raw stack traces in normal output | Too noisy for agent recovery |
| Vague text like `Something went wrong` | Not self-healing |
| Secrets or full environment dumps | Security risk |

## Testing Discipline

Use TDD.

| Phase | Required Evidence |
|-------|-------------------|
| RED | Test fails for the expected reason |
| GREEN | Minimal implementation passes |
| REFACTOR | Tests remain green after cleanup |

### Required Test Types

| Type | Purpose |
|------|---------|
| Unit | Command parsing, protected policy, error formatting |
| Integration | Real temp Git repo behavior |
| Concurrency | Lock and simultaneous commit behavior |

### Required Test Cases

| Case | Expected Result |
|------|-----------------|
| Commit without session | Blocked |
| Add without session | Blocked |
| `git getID` | Prints valid shell exports |
| `git getID` without agent identity | Blocked |
| Explicit add | Uses session index |
| Broad add, directory add, glob add | Blocked |
| Commit after clean add | Creates commit with attribution trailers |
| Reserved attribution trailer | Blocked before Git commit |
| Commit pathspec | Blocked before Git can bypass session index |
| File drift after add | Blocked |
| `HEAD` drift | Blocked |
| Opt-out config | Calls real Git |
| Human passthrough | Blocked in non-interactive agent shells |
| Agent error | Includes code and suggestions |

## Implementation Guidelines

| Topic | Rule |
|-------|------|
| Language | TypeScript source, built to Node.js ESM runtime in `dist/` |
| Dependencies | Zero runtime dependencies in v1 |
| Tests | Use built-in `node:test` unless a stronger reason appears |
| Orchestration | Keep `src/cli.ts` as the command router, not a behavior dump |
| Command policy | Keep Git command classification in `src/command-policy.ts` as the SSOT |
| Agent identity | Keep platform-specific detection in `src/agent-adapters.ts`; keep `COMMIT_QUEUE_AGENT` and `COMMIT_QUEUE_AGENT_SESSION` as the platform-agnostic fallback |
| File writes | Atomic write pattern for session state |
| Paths | Normalize through Git root-relative paths |
| Real Git | Resolve once; avoid recursive shim calls |
| Logs | JSONL under `~/.commit-queue/logs/` |
| Formatting | Run formatter after edits once package tooling exists |

## Real Git Invocation

Avoid recursive calls to the shim.

```text
commit-queue git shim
  -> resolves real Git binary
  -> runs real Git with controlled env
```

The real Git path must never resolve back to the shim.

## State Model

| State | Location | Notes |
|-------|----------|-------|
| Session metadata | `~/.commit-queue/sessions/{id}.json` | Repo, created time, parent `HEAD`, agent identity, staged paths |
| Session index | `~/.commit-queue/indexes/{id}.index` | Used through `GIT_INDEX_FILE` |
| Repo lock | `~/.commit-queue/locks/{repoHash}.lock` | Held only during commit/ref mutation; includes owner metadata |
| Event log | `~/.commit-queue/logs/events.jsonl` | Structured audit trail |

## Lock Recovery

| Lock State | Required Behavior |
|------------|-------------------|
| Active owner process | Wait, then return owner pid and lock age |
| Dead owner process | Clear lock automatically |
| Empty orphan lock | Clear lock automatically after grace period |
| Old lock | Clear lock automatically |

## Drift Rules

| Drift Type | Detection | Result |
|------------|-----------|--------|
| File content changed after add | Staged hash or file hash mismatch | Block |
| Staged path set changed unexpectedly | Session manifest mismatch | Block |
| `HEAD` moved unexpectedly | Parent SHA mismatch | Block |
| Repo opted out | Config says disabled | Pass through |

## Documentation Rules

| Document | Purpose |
|----------|---------|
| `VISION.md` | Product contract and architecture decisions |
| `AGENTS.md` | Agent operating rules |
| `README.md` | User install and usage guide, only after working CLI exists |

Do not create speculative docs beyond these unless requested.

## Completion Checklist

Before claiming implementation work is complete:

| Check | Required |
|-------|----------|
| Tests pass | Yes |
| Drift test exists | Yes |
| Broad add test exists | Yes |
| Session-required test exists | Yes |
| Human passthrough non-interactive block test exists | Yes |
| Error output is structured | Yes |
| No runtime dependencies added silently | Yes |
