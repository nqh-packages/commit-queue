# Cursor + commit-queue

Cursor does not expose a stable session UUID in the agent shell the way Codex (`CODEX_THREAD_ID`) and Pi (`PI_SESSION_ID`) do. commit-queue resolves Cursor sessions in this order:

| Priority | Source                    | Notes                                                                            |
| -------- | ------------------------- | -------------------------------------------------------------------------------- |
| 1        | `CURSOR_AGENT_SESSION_ID` | Set by the `sessionStart` hook below                                             |
| 2        | `CURSOR_CONVERSATION_ID`  | Same UUID if your Cursor build exports it                                        |
| 3        | `CURSOR_TRANSCRIPT_PATH`  | Parse UUID from transcript path when present                                     |
| 4        | Filesystem                | Newest `~/.cursor/projects/<encoded-repo>/agent-transcripts/<uuid>/<uuid>.jsonl` |

Encoded repo path for `/Volumes/BIWIN/CODES/commit-queue` is `Volumes-BIWIN-CODES-commit-queue`.

## Install (recommended: user-global)

```bash
chmod +x /Volumes/BIWIN/CODES/commit-queue/integrations/cursor/hooks/session-start.sh
```

Merge into `~/.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "command": "/Volumes/BIWIN/CODES/commit-queue/integrations/cursor/hooks/session-start.sh"
      }
    ]
  }
}
```

Use an absolute path for user hooks (they run with cwd `~/.cursor/`).

Restart Cursor or reload hooks, then start a **new** Agent chat and run:

```bash
eval "$(git getID)"
echo "$COMMIT_QUEUE_AGENT_SESSION"
# expect: cursor-<your-session-uuid>
```

## Per-repo install

Copy `integrations/cursor/hooks.json` into the repo as `.cursor/hooks.json` and keep `integrations/cursor/hooks/session-start.sh` at the path referenced there (or adjust the command path).

## Manual override

```bash
export CURSOR_AGENT_SESSION_ID="0e39f2c2-f468-4628-8d58-c5e21a6c2ebf"
eval "$(git getID)"
```

Or use explicit commit-queue vars:

```bash
export COMMIT_QUEUE_AGENT="cursor"
export COMMIT_QUEUE_AGENT_SESSION="cursor-0e39f2c2-f468-4628-8d58-c5e21a6c2ebf"
eval "$(git getID)"
```
