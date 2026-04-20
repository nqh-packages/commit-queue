import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
        COMMIT_QUEUE_INSTALL_REPO_HOOKS: "0",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /local install complete/);
    assert.doesNotMatch(result.stdout, /hgit/);

    const gitShim = path.join(home, ".commit-queue", "bin", "git");
    const humanGitShim = path.join(home, ".commit-queue", "bin", "hgit");
    assert.equal(lstatSync(gitShim).isSymbolicLink(), false);
    assert.equal(lstatSync(humanGitShim).isSymbolicLink(), false);
    assert.equal(existsSync(path.join(home, ".commit-queue", "dist", "cli.js")), true);
    assert.equal(existsSync(path.join(home, ".commit-queue", "src", "cli.js")), false);
    assert.equal(
      JSON.parse(readFileSync(path.join(home, ".commit-queue", "package.json"), "utf8")).type,
      "module",
    );

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
        COMMIT_QUEUE_INSTALL_REPO_HOOKS: "0",
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

test("local installer wires commit-queue repo hooks into Git config", () => {
  const home = mkdtempSync(path.join(tmpdir(), "commit-queue-install-"));
  const hookRepo = mkdtempSync(path.join(tmpdir(), "commit-queue-hooks-"));
  try {
    const init = spawnSync("/usr/bin/git", ["init", "-b", "main"], {
      cwd: hookRepo,
      encoding: "utf8",
    });
    assert.equal(init.status, 0, init.stderr);
    mkdirSync(path.join(hookRepo, ".githooks"));

    const install = spawnSync(process.execPath, [installer], {
      cwd: repoRoot,
      env: {
        ...process.env,
        COMMIT_QUEUE_INSTALL_HOME: home,
        COMMIT_QUEUE_REPO_HOOKS_TARGET: hookRepo,
      },
      encoding: "utf8",
    });

    assert.equal(install.status, 0, install.stderr);
    const hooksPath = spawnSync("/usr/bin/git", ["-C", hookRepo, "config", "--local", "--get", "core.hooksPath"], {
      encoding: "utf8",
    });
    assert.equal(hooksPath.status, 0, hooksPath.stderr);
    assert.equal(hooksPath.stdout.trim(), ".githooks");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(hookRepo, { recursive: true, force: true });
  }
});

test("refresh script installs committed HEAD and ignores dirty working tree edits", () => {
  const home = mkdtempSync(path.join(tmpdir(), "commit-queue-refresh-home-"));
  const sourceRepo = mkdtempSync(path.join(tmpdir(), "commit-queue-refresh-repo-"));
  try {
    cpSync(repoRoot, sourceRepo, {
      recursive: true,
      filter: (source) => ![
        ".git",
        "node_modules",
        "dist",
        "coverage",
      ].some((name) => source === path.join(repoRoot, name) || source.startsWith(`${path.join(repoRoot, name)}${path.sep}`)),
    });
    assert.equal(spawnSync("/usr/bin/git", ["init", "-b", "main"], { cwd: sourceRepo, encoding: "utf8" }).status, 0);
    assert.equal(spawnSync("/usr/bin/git", ["config", "user.name", "Commit Queue Test"], { cwd: sourceRepo }).status, 0);
    assert.equal(spawnSync("/usr/bin/git", ["config", "user.email", "commit-queue@example.test"], { cwd: sourceRepo }).status, 0);
    assert.equal(spawnSync("/usr/bin/git", ["add", "."], { cwd: sourceRepo }).status, 0);
    assert.equal(spawnSync("/usr/bin/git", ["commit", "-m", "test: source"], { cwd: sourceRepo, encoding: "utf8" }).status, 0);
    symlinkSync(path.join(repoRoot, "node_modules"), path.join(sourceRepo, "node_modules"), "dir");

    writeFileSync(path.join(sourceRepo, "bin", "git"), "#!/bin/sh\nprintf 'dirty hook leak\\n'\n");

    const result = spawnSync(process.execPath, [path.join(sourceRepo, "scripts", "refresh-installed-runtime.js"), "--hook", "test"], {
      cwd: sourceRepo,
      env: {
        ...process.env,
        COMMIT_QUEUE_INSTALL_HOME: home,
        COMMIT_QUEUE_REAL_GIT: "/usr/bin/git",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /installed runtime refreshed/);
    assert.equal(existsSync(path.join(home, ".commit-queue", "dist", "cli.js")), true);
    assert.doesNotMatch(readFileSync(path.join(home, ".commit-queue", "bin", "git"), "utf8"), /dirty hook leak/);

    const marker = path.join(home, ".commit-queue", "stale-installs", `${createHash("sha256").update(sourceRepo).digest("hex").slice(0, 24)}.json`);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(sourceRepo, { recursive: true, force: true });
  }
});
