# commit-queue

Tiny Git safety wrapper for people running multiple AI coding agents in the same local repos.

| Question      | Answer                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------ |
| What is this? | A protected `git` shim plus a raw human `hgit` command                                           |
| Why use it?   | Agents stop committing over each other                                                           |
| Why it works  | Each agent session gets isolated staging, commits serialize, and commits carry agent attribution |
| Status        | Local v1                                                                                         |

Agent flow:

```bash
eval "$(git getID)"
git add src/file.ts
git commit -m "fix: update file"
```

For unsupported agents, provide explicit attribution before `git getID`:

```bash
export COMMIT_QUEUE_AGENT="codex"
export COMMIT_QUEUE_AGENT_SESSION="codex-917838637383"
eval "$(git getID)"
```

Both explicit variables are required. `COMMIT_QUEUE_AGENT_SESSION` alone is not enough because commit attribution needs the coding platform name and the platform session id.

Built-in identity adapters:

| Adapter    | Env                                                |
| ---------- | -------------------------------------------------- |
| `explicit` | `COMMIT_QUEUE_AGENT`, `COMMIT_QUEUE_AGENT_SESSION` |
| `codex`    | `CODEX_THREAD_ID`                                  |
| `opencode` | `OPENCODE_SESSION_ID`                              |

Human flow, from an interactive terminal:

```bash
hgit status
hgit add .
hgit commit -m "manual commit"
```

## What Is This?

| Command | Meaning                  |
| ------- | ------------------------ |
| `git`   | Protected Git for agents |
| `hgit`  | Raw Git for humans       |

It is enabled for every Git repo by default. A repo can opt out with:

```json
{
  "enabled": false
}
```

## Why It Helps

The common mess:

```text
Agent A edits file-a.ts
Agent B edits file-b.ts
Agent B runs git add .
Agent A commits

Now Agent A's commit may contain Agent B's work.
```

`commit-queue` blocks that class of mistake before it becomes history.

## Why It Works

| Problem                            | commit-queue Rule                                             |
| ---------------------------------- | ------------------------------------------------------------- |
| Agents share one Git index         | Each session gets its own index with `GIT_INDEX_FILE`         |
| Agents use broad staging           | `git add .`, `git add -A`, and `git commit -a` are blocked    |
| Agents commit at the same time     | Commits run through a per-repo lock                           |
| A stale lock remains               | Lock owner metadata lets the wrapper recover it automatically |
| A file changes after staging       | Commit blocks until the agent stages again                    |
| Commit history loses agent context | Protected commits append attribution trailers                 |
| Humans need escape                 | `hgit` calls real Git only from an interactive terminal       |

## Why It Is Good

| Good Part               | Why It Matters                                            |
| ----------------------- | --------------------------------------------------------- |
| Normal agent commands   | No new agent skill per tool                               |
| No worktree requirement | No extra pruning, trimming, folder cleanup                |
| No daemon               | Nothing to keep alive                                     |
| No per-tool hook setup  | Claude Code, Codex, and shell agents hit the same wrapper |
| Raw human escape        | `hgit` stays available for interactive operators          |

## How To Use It

Local install:

```bash
npm run install:local
```

Install shape:

```text
~/.commit-queue/bin/git   -> commit-queue protected shim
~/.commit-queue/bin/hgit  -> raw Git passthrough
```

Development:

```bash
npm run build
npm test
npm run test:coverage
```

`npm run install:local` also configures this repository's `.githooks`. After `post-commit`, `post-merge`, and `post-checkout`, the hook rebuilds and reinstalls the committed `HEAD` runtime into `~/.commit-queue`. If that refresh fails, protected `git add` and `git commit` in this repo block until the refresh succeeds.

Agent flow:

```bash
eval "$(git getID)"
git add path/to/file
git commit -m "fix: describe change"
```

Protected commits append native Git trailers:

```text
Commit-Queue-Session: cq_20260414_ab12
Coding-Agent: codex
Coding-Agent-Session: codex-917838637383
```

Human flow:

```bash
hgit add .
hgit commit -m "manual commit"
```

GUI human bypass flow:

When a human cannot use an interactive terminal, commit-queue can treat a local
GUI commit as a first-class human bypass if the commit message includes a
standalone local secret line. The secret itself is not stored in the repo or in
Git history: commit-queue reads a local hash from its user runtime state, strips
the matching message line, and then calls real Git with the normal Git index.

The local runtime config is intentionally machine-local. Store only a SHA-256
hash of the phrase:

```json
{
  "humanNoVerifyPhraseHash": "<sha256-of-local-phrase>"
}
```

Use a normal commit subject plus the local phrase as its own line in the GUI
commit message. Do not use a shared, obvious, or repository-documented phrase.

Opt out a repo:

```json
{
  "enabled": false
}
```

Protected in v1:

```bash
git add .
git add -A
git add -u
git add dir/
git add "*.ts"
git add --pathspec-from-file paths.txt
git commit -a
git commit --no-verify
git commit --amend
git commit --only path/to/file
git -c core.hooksPath=/dev/null commit -m "..."
git config core.hooksPath /dev/null
git config hook.lint.command "npm test"
git history reword HEAD
git commit -m "..." --trailer "Coding-Agent: fake"
```

Other Git commands pass through to real Git. `commit-queue` protects staging and commits; it is not a full Git sandbox.

Read the full product contract in [VISION.md](./VISION.md).
