import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  encodeCursorProjectDir,
  resolveLatestCursorSessionId,
  sessionIdFromTranscriptPath,
} from "../dist/cursor-session.js";

const SESSION_A = "0e39f2c2-f468-4628-8d58-c5e21a6c2ebf";
const SESSION_B = "11111111-1111-4111-8111-111111111111";

test("encodeCursorProjectDir matches Cursor projects folder naming", () => {
  assert.equal(
    encodeCursorProjectDir("/Volumes/BIWIN/CODES/commit-queue"),
    "Volumes-BIWIN-CODES-commit-queue",
  );
});

test("sessionIdFromTranscriptPath reads uuid from jsonl path", () => {
  const transcript = path.join(
    os.homedir(),
    ".cursor",
    "projects",
    "Volumes-BIWIN-CODES-company-runner",
    "agent-transcripts",
    SESSION_A,
    `${SESSION_A}.jsonl`,
  );
  assert.equal(sessionIdFromTranscriptPath(transcript), SESSION_A);
});

test("resolveLatestCursorSessionId picks newest transcript for repo", () => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-cursor-"));
  const repo = "/Volumes/BIWIN/CODES/commit-queue";
  const encoded = encodeCursorProjectDir(repo);
  const base = path.join(
    homedir,
    ".cursor",
    "projects",
    encoded,
    "agent-transcripts",
  );

  for (const [id, offsetMs] of [
    [SESSION_A, 5_000],
    [SESSION_B, 0],
  ]) {
    const dir = path.join(base, id);
    fs.mkdirSync(dir, { recursive: true });
    const jsonl = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(jsonl, "{}\n");
    const atime = Date.now() - offsetMs;
    fs.utimesSync(jsonl, atime / 1000, atime / 1000);
  }

  assert.equal(resolveLatestCursorSessionId(repo, homedir), SESSION_B);
  fs.rmSync(homedir, { recursive: true, force: true });
});
