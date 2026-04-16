# commit-queue Vision

## Why This Exists

I am annoyed by agents committing over each other.

That is the whole reason.

I have a bunch of apps living inside monorepos. Astro apps in one place, Expo apps in one place, Swift apps in one place, TanStack apps in one place. They are separate products, but the tooling, agent configs, rules, scripts, prompts, and shared habits are easier when they live together. So yes, `git worktree` makes sense in theory. It is the correct Git answer if you want isolation.

But in my case it adds another layer of things I need to take care of. Create worktrees, prune them, trim them, remember which agent is in which folder, clean stale branches, fix the one that is still pointing at old stuff. Gosh, another thing.

The more context I need to give an agent, the less effective the work gets. I do not want a separate skill for Claude Code, another hook setup for Codex, another rule for a different agent, another explanation about where to commit. I want the agents to keep using `git`, and I want `git` to stop letting them make a mess.

So `commit-queue` wraps `git`.

## What It Is

`commit-queue` is a small local Git shim for AI-agent-heavy development.

| It Is | It Is Not |
|-------|-----------|
| A protected `git` command | A new version control system |
| A local safety layer around staging and commits | A hosted queue service |
| A way to make agents use the same Git protocol | A replacement for good task boundaries |
| A guard against mixed commits | A magic conflict resolver |
| A human escape hatch with `hgit` | A prison around Git |

The point is not to make Git clever. The point is to remove one stupid failure mode.

## The Failure Mode

Multiple agents in one checkout share the same Git index and the same branch.

```text
Agent A edits file-a.ts
Agent B edits file-b.ts
Agent B runs git add .
Agent A runs git commit -m "fix: a"

Result:
  Agent A may commit Agent B's work.
```

That is not a rare edge case once agents run in parallel. That is Tuesday.

## Why Existing Answers Are Not Enough

| Answer | Why It Makes Sense | Why I Am Not Starting There |
|--------|--------------------|-----------------------------|
| `git worktree` | Real isolation, built into Git | Adds folders, cleanup, pruning, branch hygiene, and more operating context |
| Git hooks | Good for checks before commit | Hooks do not isolate staging, and every agent/tool has its own setup habits |
| Agent-specific rules | Easy for one agent | Does not scale across Claude Code, Codex, terminal agents, scripts, and future tools |
| Teach agents better Git | Sounds nice | Agents still forget, race, and use broad commands |
| New VCS like `jj` | Good ideas, cleaner mental model | Different workflow, different context, more migration |

I want the boring thing that catches the common mess without changing how every repo works.

## Core Bet

If every agent already calls `git`, then `git` is the right choke point.

```text
agent
  |
  v
git command
  |
  v
commit-queue policy
  |
  v
real git
```

No daemon. No server. No app-specific hooks. No per-agent plugin.

Just one shim.

## User Model

| User | What They Want | Command |
|------|----------------|---------|
| Agent | Safe normal Git flow | `git getID`, `git add path`, `git commit -m "..."` |
| Human | Raw Git when needed | `hgit ...` |
| Future user | Install once, understand fast | `git` protected, `hgit` raw |

## Product Contract

| Area | Decision |
|------|----------|
| Name | `commit-queue` |
| Protected command | `git` |
| Human/raw command | `hgit` |
| Default scope | Enabled for every Git repo |
| Opt-out | `.commit-queue.json` with `{ "enabled": false }` |
| Session command | `eval "$(git getID)"` |
| Session identity | `COMMIT_QUEUE_ID`, `COMMIT_QUEUE_REPO` |
| Staging | Explicit file paths only |
| Staging isolation | One Git index per session through `GIT_INDEX_FILE` |
| Commit safety | Repo lock, staged-path check, drift check, `HEAD` check |
| State | `~/.commit-queue/` |

## Command Model

### Agent Flow

```bash
eval "$(git getID)"
git add src/foo.ts
git commit -m "fix: handle foo state"
```

### Human Flow

```bash
hgit status
hgit add .
hgit commit -m "fix: manual cleanup"
```

### Install Shape

```text
~/.local/bin/git   -> commit-queue protected shim
~/.local/bin/hgit  -> raw Git passthrough
```

## Why `git getID` Exists

Agents need identity before they stage or commit through `commit-queue`.

```text
No ID:
  normal Git passes through
  protected add/commit are blocked

With ID:
  this session gets its own index
  this session owns its staged paths
  this session gets clear errors when something changed
```

This keeps the protocol explicit. I do not want hidden magic where the tool silently guesses which agent is which and then I debug ghosts later.

## Safety Rules

### Owned Commands

| Command | Behavior |
|---------|----------|
| `git getID` | Creates a session and prints shell exports |
| `git add explicit/path` | Stage into this session's private index |
| `git commit -m "..."` | Lock repo, verify, commit through real Git |

### Pass Through

| Command | Why |
|---------|-----|
| Any non-owned Git command | `commit-queue` is not a Git firewall; it only protects staging and commit boundaries |

Examples: `git clone`, `git fetch`, `git tag`, `git branch`, `git config`, `git checkout`, `git reset`, and future Git commands all pass through to real Git.

### Blocked For Protected Commits In v1

| Command | Why |
|---------|-----|
| `git add .` | It can grab other agents' files |
| `git add -A` | It can grab unrelated edits and deletes |
| `git add -u` | It can grab unrelated deletions |
| `git add dir/` | It can grab many files under one broad path |
| `git add "*.ts"` | It can expand into unrelated files |
| `git add --pathspec-from-file` | It hides the actual staged paths from the command line |
| `git commit -a` | It bypasses explicit staging |
| `git commit --no-verify` | It skips repository hooks |
| `git commit --amend` | It rewrites history |
| `git commit path/to/file` | It can bypass the private session index |
| `git -c ... commit` | Inline config can bypass protected commit assumptions |

Broad commands are not evil. They are just wrong when five agents share one checkout.

## Why Drift Detection Exists

The lock only protects the commit moment. It does not protect the time between `git add` and `git commit`.

```text
Agent A:
  git add src/foo.ts

Agent B:
  edits src/foo.ts

Agent A:
  git commit -m "fix: foo"
```

If the file changed after Agent A staged it, Agent A needs to know. The new content can be intentional, or it can be another agent overwriting the same file. `commit-queue` should not guess.

It blocks and asks the agent to stage again.

### Minimal v1 Check

| Check | Captured At `git add` | Verified At `git commit` |
|-------|------------------------|---------------------------|
| Path set | Repo-relative paths | Commit only includes those paths |
| Staged content | Blob hash or file hash | Content still matches staged intent |
| Parent commit | `HEAD` SHA | Parent did not move unexpectedly |

### Failure

```text
[commit-queue] blocked: staged file changed before commit

error_code: COMMIT_QUEUE_FILE_DRIFT
path: src/foo.ts
session: cq_20260414_ab12
suggestion: Run `git add src/foo.ts` again if this content is intentional.
```

No auto-merge. No clever fix. Just block the mess.

## Why Per-Session Indexes Work

Git already has the primitive we need: `GIT_INDEX_FILE`.

Normally every command uses the repo's shared index:

```text
.git/index
```

`commit-queue` gives each session its own index:

```text
~/.commit-queue/indexes/cq_20260414_ab12.index
```

So when an agent runs:

```bash
git add src/foo.ts
```

the real command underneath is closer to:

```bash
GIT_INDEX_FILE=~/.commit-queue/indexes/cq_20260414_ab12.index \
  /usr/bin/git add src/foo.ts
```

The agent gets normal Git behavior. The shared index does not get polluted.

## Global Default And Opt-Out

### Default

```text
If the protected shim is first in PATH, every Git repo is protected.
```

This is intentional. I do not want to remember which repo has the setup and which one does not.

### Repo Opt-Out

```json
{
  "enabled": false,
  "reason": "Third-party repo; raw Git behavior expected"
}
```

### Human Bypass

```bash
hgit status
hgit add .
hgit commit -m "manual commit"
```

`hgit` exists because humans need a door out. It is for interactive terminals; non-interactive agent shells should be blocked. Agents do not need to be taught where that door is.

## Architecture

```text
shell command
  |
  v
~/.local/bin/git
  |
  +-- outside Git repo -----------------------> real git
  |
  +-- repo opted out -------------------------> real git
  |
  +-- git getID ------------------------------> create session + print exports
  |
  +-- git add/commit without session ---------> structured block
  |
  +-- git add/commit with session ------------> policy engine
                                                  |
                                                  v
                                                real git with controlled env
  |
  +-- any other Git command ------------------> real git
```

## Components

| Component | Responsibility |
|-----------|----------------|
| `bin/git` | Protected shim entrypoint |
| `bin/hgit` | Raw Git passthrough for interactive humans |
| `src/cli.ts` | Orchestrates command routing only |
| `src/command-policy.ts` | SSOT for protected add/commit option shapes |
| `src/git-runtime.ts` | Resolves real Git, repo root, refs, staged paths, and blobs |
| `src/session-store.ts` | Creates and loads `COMMIT_QUEUE_ID` metadata and private indexes |
| `src/repo-lock.ts` | Serializes commit/ref mutation per repo |
| `src/commands/*` | Owns behavior for supported protected commands |
| `src/errors.ts` | Prints structured agent-readable failures |
| Event logger | Writes JSONL audit trail |

## Error Contract

Agent errors need to be useful enough that the next command is obvious.

| Field | Required | Why |
|-------|----------|-----|
| `error_code` | Yes | Machine-readable recovery |
| `detail` | Yes | What failed |
| `context` | Yes | Repo, command, path, session |
| `suggestions` | Yes | Exact next commands |
| `retriable` | Yes | Whether the agent can fix and retry |

### Human Text

```text
[commit-queue] blocked: mutating Git command requires a session

Run:
  eval "$(git getID)"
```

### JSON Mode

```bash
COMMIT_QUEUE_JSON=1 git add src/foo.ts
```

```json
{
  "type": "https://commit-queue.local/errors/session-required",
  "title": "Commit queue session required",
  "status": 409,
  "detail": "Git command 'add' is protected because you are sharing this checkout with other agents. Start a commit-queue session before staging or committing.",
  "error_code": "COMMIT_QUEUE_SESSION_REQUIRED",
  "timestamp": "2026-04-14T00:00:00.000Z",
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

Agent-facing errors must not mention `hgit` or bypass commands.

## Runtime State

```text
~/.commit-queue/
  sessions/
    cq_20260414_ab12.json
  indexes/
    cq_20260414_ab12.index
  locks/
    repo-hash.lock
  logs/
    events.jsonl
```

| State | Purpose |
|-------|---------|
| Session JSON | Repo, session ID, created time, starting `HEAD`, staged paths |
| Session index | Private Git index for that agent |
| Repo lock | Prevents simultaneous commit/ref mutation |
| Event log | Debug trail for humans |

## v1 Behavior Matrix

| Scenario | Expected Result |
|----------|-----------------|
| Agent runs `git add src/a.ts` without session | Block |
| Agent runs `eval "$(git getID)"` | Export `COMMIT_QUEUE_ID` and `COMMIT_QUEUE_REPO` |
| Agent runs `git add src/a.ts` with session | Stage into session index |
| Agent runs `git add .` with session | Block |
| Agent runs `git add dir/` with session | Block |
| Agent runs `git commit -m "fix: a"` with clean session | Commit through repo lock |
| Agent runs `git commit src/a.ts -m "fix: a"` | Block |
| Staged file changed after add | Block with `COMMIT_QUEUE_FILE_DRIFT` |
| `HEAD` changed unexpectedly | Block with `COMMIT_QUEUE_HEAD_DRIFT` |
| Human runs `hgit commit -m "..."` in an interactive terminal | Raw Git passthrough |
| Repo has `{ "enabled": false }` | Raw Git passthrough |

## Testing Standard

Tests use real temporary Git repositories. No fake Git behavior unless the unit is pure parsing.

| Layer | Target | Tool |
|-------|--------|------|
| Unit | Command parsing, protected command policy, error formatting | `node:test` |
| Integration | Shim behavior in temp repos | `node:test`, real Git |
| Concurrency | Lock and simultaneous commit behavior | Child processes |

### Required Cases

| Case | Assertion |
|------|-----------|
| Session required | Mutating command fails before `git getID` |
| Explicit path only | `git add .` and `git add -A` fail |
| Private index | `git add file` does not pollute shared index |
| Commit lock | Concurrent commits serialize |
| Drift detection | Commit fails if staged file changed after add |
| `HEAD` drift | Commit fails if parent changed unexpectedly |
| Opt-out | Repo config disables wrapper behavior |
| Human passthrough | Non-interactive shells are blocked |
| Error structure | Blocked command includes code and suggestions |

## Implementation Constraints

| Constraint | Rule |
|------------|------|
| Runtime | Node.js CLI |
| Runtime dependencies | Zero for v1 |
| Platform | macOS first, portable shell assumptions where easy |
| Real Git | Resolve safely and never recurse into shim |
| File writes | Atomic writes for session JSON |
| Locks | Stale-lock recovery required |
| Logs | JSONL, no secrets |
| Agent errors | No bypass hints |

## Future Versions

| Version | Capability | Trigger |
|---------|------------|---------|
| v1 | Protected `git`, `hgit`, session, explicit add, commit lock, drift check | Initial usable release |
| v1.1 | `git queue status`, `git queue sessions`, cleanup | Debugging stale sessions |
| v1.2 | Safe `git rm` and rename tracking | Agents need delete/rename support |
| v2 | Optional path claims | Same-file conflicts happen too often |
| v2 | Optional background queue worker | Need queued commits after agents exit |
| v3 | Team policy presets | Public package needs presets |

## What Good Looks Like

| Outcome | Signal |
|---------|--------|
| Agents stop committing over each other | Concurrent commits serialize cleanly |
| Mixed commits become rare | Commits contain only session-staged paths |
| Agents recover by themselves | Error output gives the exact next command |
| Humans stay in control | `hgit` works when I need raw Git |
| The tool stays boring | No daemon, no watcher, no new VCS |
