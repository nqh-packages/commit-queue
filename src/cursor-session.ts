import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const CURSOR_SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cursor encodes workspace roots as `Volumes-BIWIN-CODES-commit-queue`. */
export function encodeCursorProjectDir(absPath: string): string {
  let normalized = path.resolve(absPath);
  if (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  return normalized.split(path.sep).join("-");
}

export function isCursorSessionUuid(value: string): boolean {
  return CURSOR_SESSION_UUID_RE.test(value.trim());
}

/** Extract session UUID from `.../agent-transcripts/<uuid>/<uuid>.jsonl`. */
export function sessionIdFromTranscriptPath(
  transcriptPath: string,
): string | null {
  const trimmed = transcriptPath.trim();
  if (!trimmed) return null;

  const base = path.basename(trimmed, ".jsonl");
  if (isCursorSessionUuid(base)) return base;

  const parent = path.basename(path.dirname(trimmed));
  if (isCursorSessionUuid(parent)) return parent;

  return null;
}

/**
 * Most recently updated Cursor agent transcript for a repo root.
 * Used when Cursor does not inject a session env into the agent shell.
 */
export function resolveLatestCursorSessionId(
  repoRoot: string,
  homeDir: string = homedir(),
): string | null {
  const encoded = encodeCursorProjectDir(repoRoot);
  const transcriptsDir = path.join(
    homeDir,
    ".cursor",
    "projects",
    encoded,
    "agent-transcripts",
  );
  if (!existsSync(transcriptsDir)) return null;

  let best: { id: string; mtime: number } | null = null;
  for (const entry of readdirSync(transcriptsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isCursorSessionUuid(entry.name)) continue;

    const jsonl = path.join(transcriptsDir, entry.name, `${entry.name}.jsonl`);
    if (!existsSync(jsonl)) continue;

    const mtime = statSync(jsonl).mtimeMs;
    if (!best || mtime > best.mtime) {
      best = { id: entry.name, mtime };
    }
  }

  return best?.id ?? null;
}
