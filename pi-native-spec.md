# pi Native Spec

## Goal

Prevent pi-driven agents from creating mixed or unsafe Git commits in a shared checkout.

## Product Shape

This is a **pi-native Git safety layer**, not a protected `git` shim.

| Concern | Decision |
|---|---|
| Runtime | pi extension(s) |
| Choke point | pi `bash` / `user_bash` interception + native Git tools |
| Raw shell Git | Read-only only |
| Git mutation | Native pi tools only |
| Index isolation | Hidden per-pi-session private index via `GIT_INDEX_FILE` |
| Human bypass | Outside scope for the extension; users can still use normal terminal Git outside pi |

## Core Rule

```text
Inside pi:
  raw shell Git is read-only
  all Git mutations go through native pi Git tools
```

## Why This Exists

Multiple pi sessions in the same repo can still:
- edit unrelated files in parallel
- stage too broadly
- commit each other's work accidentally

The goal is to make the right Git behavior the default and the wrong behavior hard or impossible.

## Non-Goals

| Non-goal | Why |
|---|---|
| Protected PATH shim | Wrong abstraction for pi-native behavior |
| `git getID` / shell exports | pi can keep session state internally |
| `hgit` | Belongs to standalone wrapper design, not pi-native UX |
| New VCS | Problem is safety around Git, not replacing Git |
| Agent-wide cross-tool protection | Scope is pi only |

## User Experience

### Allowed raw shell Git

```bash
!git status
!git diff
!git log --oneline -5
!git show HEAD~1
!git ls-files
```

### Blocked raw shell Git

```bash
!git add .
!git add src/foo.ts
!git commit -m "fix"
!git checkout main
!git reset --hard
```

### Expected agent workflow

The model uses native pi tools instead of raw mutable Git:
- `git_status`
- `git_diff`
- `git_stage`
- `git_commit`
- optional helpers like `git_session_status`, `git_unstage`, `git_diff_staged`

## Runtime Architecture

## Layers

| Layer | Responsibility |
|---|---|
| Interception extension | Block raw mutable Git in `bash` and `user_bash` |
| Native Git tool extension | Expose safe Git mutation/read tools to the model |
| Hidden state store | Track per-session index, staged paths, hashes, parent `HEAD` |
| UI status | Show Git safety/session state in footer or widget |

## Native Tools

### `git_status`
Read-only wrapper around `git status`.

**Input**
- optional porcelain flag or path filter later if needed

**Behavior**
- uses real Git
- no state mutation

### `git_diff`
Read-only wrapper around `git diff`.

**Input**
- optional `paths: string[]`
- optional mode: working vs staged later if needed

### `git_stage`
Stage explicit file paths into the session's private index.

**Input**
- `paths: string[]`

**Rules**
- required explicit file paths only
- reject `.`
- reject directories
- reject globs
- reject `-A`, `-u`, `--pathspec-from-file`
- normalize to repo-relative paths
- record content hash/blob hash at stage time
- capture parent `HEAD` if not already captured

**Success result details**
- repo root
- normalized staged paths
- parent `HEAD`
- updated staged manifest

### `git_commit`
Commit only what the current pi Git session staged.

**Input**
- `message: string`

**Rules**
- requires existing session state
- requires staged paths
- acquire repo lock
- verify current `HEAD` equals captured parent `HEAD`
- verify each staged path still matches staged intent
- commit using the private index only
- clear staged manifest after successful commit

**Failure modes**
- no active stage state
- file drift
- `HEAD` drift
- lock unavailable

### Optional tools for v1.1+
- `git_session_status`
- `git_unstage`
- `git_diff_staged`
- `git_reset_session`

## Raw Git Command Policy

### Pass through

| Command | Notes |
|---|---|
| `git status` | pass |
| `git diff` | pass |
| `git log` | pass |
| `git show` | pass |
| `git ls-files` | pass |
| `git branch` | pass for read-only forms only |
| `git rev-parse` | pass if needed internally |

### Block

| Command | Reason |
|---|---|
| `git add ...` | all mutation must go through native tools |
| `git commit ...` | all mutation must go through native tools |
| `git reset ...` | destructive/shared-tree mutation |
| `git restore ...` | destructive/shared-tree mutation |
| `git checkout ...` | shared-tree mutation |
| `git switch ...` | shared-tree mutation |
| `git merge` | history/shared-tree mutation |
| `git rebase` | history/shared-tree mutation |
| `git pull` | hidden history mutation |
| `git stash` | shared-tree mutation |
| `git push --force` | remote history rewrite |

## State Model

Hidden per-pi-session Git state:

| Field | Purpose |
|---|---|
| `repoRoot` | Canonical repo identity |
| `indexPath` | Private `GIT_INDEX_FILE` |
| `parentHead` | Expected commit parent for safe commit |
| `stagedPaths` | Explicit paths owned by this pi Git session |
| `pathHashes` | Drift detection at commit time |
| `createdAt` | Diagnostics |
| `updatedAt` | Diagnostics |

## Storage

Suggested location:

```text
~/.pi/agent/state/git-guard/
  sessions/
  indexes/
  locks/
  logs/
```

## Session Identity

Do **not** expose shell env vars.

Use pi runtime/session identity internally:
- current pi session file or session id
- cwd / repo root
- extension-managed manifest

## Commit Safety Model

### Private index

Each pi session gets its own index file:

```text
GIT_INDEX_FILE=~/.pi/agent/state/git-guard/indexes/<session>.index
```

This prevents one pi session from polluting the shared `.git/index`.

### Repo lock

Before commit:
- acquire per-repo lock
- auto-clear stale/orphan lock when safe
- serialize commit/ref mutation

### Drift checks

At commit time verify:

| Check | Result on failure |
|---|---|
| `HEAD` matches captured `parentHead` | block with head drift |
| each staged path still matches staged hash/blob | block with file drift |
| staged path set still matches manifest | block |

## Error Contract

Errors should be short, actionable, agent-recoverable.

| Field | Required |
|---|---|
| `error_code` | yes |
| `detail` | yes |
| `context` | yes |
| `suggestions` | yes |
| `retriable` | yes |

### Example blocked raw shell mutation

```json
{
  "error_code": "PI_GIT_MUTATION_BLOCKED",
  "detail": "Raw shell Git mutation is blocked inside pi.",
  "context": {
    "command": "git commit -m \"fix\"",
    "repo": "/repo"
  },
  "retriable": true,
  "suggestions": [
    "Use the native Git tools instead of raw shell Git mutation.",
    "Stage explicit files with git_stage before calling git_commit."
  ]
}
```

### Example drift error

```json
{
  "error_code": "PI_GIT_FILE_DRIFT",
  "detail": "A staged file changed after it was staged.",
  "context": {
    "path": "src/foo.ts",
    "repo": "/repo"
  },
  "retriable": true,
  "suggestions": [
    "Stage the file again with git_stage if the new content is intentional.",
    "Review git_diff before committing."
  ]
}
```

## UI

Minimal status widget/footer line:

```text
git-guard: ready
```

When active:

```text
git-guard: 2 staged • HEAD a1b2c3 • repo commit-queue
```

Optional notifications:
- session created lazily on first `git_stage`
- commit blocked due to drift
- commit succeeded and session cleared

## Suggested Extension Layout

```text
.pi/extensions/git-guard/
  index.ts
  command-policy.ts
  git-runtime.ts
  session-store.ts
  repo-lock.ts
  tools.ts
  errors.ts
  ui.ts
```

## Module Responsibilities

| File | Responsibility |
|---|---|
| `index.ts` | register events, tools, status UI |
| `command-policy.ts` | classify raw Git shell commands as pass/block |
| `git-runtime.ts` | resolve repo root, invoke real Git safely, hash files |
| `session-store.ts` | load/save hidden Git session manifests |
| `repo-lock.ts` | per-repo commit lock |
| `tools.ts` | `git_status`, `git_diff`, `git_stage`, `git_commit` |
| `errors.ts` | structured agent-facing errors |
| `ui.ts` | footer/widget helpers |

## Implementation Order

### v1
1. Block raw mutable Git in `bash` and `user_bash`
2. Add `git_status`, `git_diff`, `git_stage`, `git_commit`
3. Add hidden private index management
4. Add repo lock + drift checks
5. Add minimal status widget

### v1.1
1. `git_session_status`
2. `git_unstage`
3. better diagnostics/logging

## Acceptance Criteria

| Scenario | Expected Result |
|---|---|
| model runs raw `git add .` in `bash` | blocked |
| user runs `!git commit -m ...` | blocked |
| user/model runs `git status` | allowed |
| `git_stage(["src/a.ts"])` | staged into private index |
| `git_commit("fix: a")` after valid stage | creates commit |
| file changes after stage | commit blocked with drift error |
| `HEAD` changes after stage | commit blocked with head drift error |
| second pi session stages different file | no shared-index pollution |

## Design Principle

The interface should be **pi-native and boring**:
- raw shell Git for reading
- native pi tools for mutation
- hidden safety machinery underneath

Do not surface standalone-wrapper concepts unless pi later needs them for cross-process coordination.
