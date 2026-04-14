import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(repoRoot, "scripts/install-local.js");

test("local installer wires commit-queue into common shell startup files", () => {
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

    for (const profile of [".zprofile", ".zshrc", ".zshenv", ".bash_profile", ".bashrc", ".profile"]) {
      const content = readFileSync(path.join(home, profile), "utf8");
      assert.match(content, /# >>> commit-queue >>>/);
      assert.match(content, /\$HOME\/\.commit-queue\/bin/);
      assert.match(content, /commit_queue_bin=/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("local installer keeps commit-queue first without duplicating PATH entries", () => {
  const home = mkdtempSync(path.join(tmpdir(), "commit-queue-install-"));
  try {
    const install = spawnSync(process.execPath, [installer], {
      cwd: repoRoot,
      env: {
        ...process.env,
        COMMIT_QUEUE_INSTALL_HOME: home,
      },
      encoding: "utf8",
    });
    assert.equal(install.status, 0, install.stderr);

    const checks = [
      { shell: "/bin/zsh", args: ["-c", "printf '%s\\n' \"$PATH\""] },
      { shell: "/bin/zsh", args: ["-ic", "printf '%s\\n' \"$PATH\""] },
      { shell: "/bin/bash", args: ["-lc", "printf '%s\\n' \"$PATH\""] },
      { shell: "/bin/bash", args: ["-ic", "printf '%s\\n' \"$PATH\""] },
    ].filter(({ shell }) => existsSync(shell));

    for (const { shell, args } of checks) {
      const result = spawnSync(shell, args, {
        env: {
          HOME: home,
          ZDOTDIR: home,
          PATH: `/opt/homebrew/bin:${path.join(home, ".commit-queue", "bin")}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const pathParts = result.stdout.trim().split(":");
      assert.equal(pathParts[0], path.join(home, ".commit-queue", "bin"));
      assert.equal(
        pathParts.filter((entry) => entry === path.join(home, ".commit-queue", "bin")).length,
        1,
        `${shell} ${args[0]} should not duplicate commit-queue PATH entries`,
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
