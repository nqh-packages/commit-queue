import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(repoRoot, "scripts/install-local.js");

test("local installer wires commit-queue into login, interactive, and non-interactive zsh startup files", () => {
  const home = mkdtempSync(path.join(tmpdir(), "commit-queue-install-"));
  try {
    const result = spawnSync(process.execPath, [installer], {
      cwd: repoRoot,
      env: {
        ...process.env,
        COMMIT_QUEUE_INSTALL_HOME: home,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /local install complete/);

    for (const profile of [".zprofile", ".zshrc", ".zshenv"]) {
      const content = readFileSync(path.join(home, profile), "utf8");
      assert.match(content, /# >>> commit-queue >>>/);
      assert.match(content, /\$HOME\/\.commit-queue\/bin/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
