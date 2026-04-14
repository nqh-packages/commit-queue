#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.COMMIT_QUEUE_INSTALL_HOME || homedir();
const binDir = path.join(home, ".commit-queue", "bin");
const managedBlock = [
  "# >>> commit-queue >>>",
  "commit_queue_bin=\"$HOME/.commit-queue/bin\"",
  "if [ -d \"$commit_queue_bin\" ]; then",
  "  commit_queue_path=\"$(printf '%s' \"$PATH\" | awk -v bin=\"$commit_queue_bin\" 'BEGIN { RS=\":\" } $0 != bin && $0 != \"\" { parts[++n] = $0 } END { for (i = 1; i <= n; i++) printf \"%s%s\", (i > 1 ? \":\" : \"\"), parts[i] }')\"",
  "  export PATH=\"$commit_queue_bin${commit_queue_path:+:$commit_queue_path}\"",
  "  unset commit_queue_bin commit_queue_path",
  "fi",
  "# <<< commit-queue <<<",
  "",
].join("\n");

mkdirSync(binDir, { recursive: true });
installSymlink(path.join(repoRoot, "bin/git"), path.join(binDir, "git"));
installSymlink(path.join(repoRoot, "bin/hgit"), path.join(binDir, "hgit"));
ensureShellProfile(path.join(home, ".zprofile"));
ensureShellProfile(path.join(home, ".zshrc"));
ensureShellProfile(path.join(home, ".zshenv"));
ensureShellProfile(path.join(home, ".bash_profile"));
ensureShellProfile(path.join(home, ".bashrc"));
ensureShellProfile(path.join(home, ".profile"));

process.stdout.write([
  "[commit-queue] local install complete",
  `git: ${path.join(binDir, "git")}`,
  `hgit: ${path.join(binDir, "hgit")}`,
  "Restart the shell or run: export PATH=\"$HOME/.commit-queue/bin:$PATH\"",
  "",
].join("\n"));

function installSymlink(source, target) {
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      rmSync(target);
    } else {
      renameSync(target, `${target}.backup-${Date.now()}`);
    }
  }
  symlinkSync(source, target);
}

function ensureShellProfile(profilePath) {
  const current = existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";
  const next = replaceManagedBlock(current);
  if (next !== current) {
    writeFileSync(profilePath, next);
  }
}

function replaceManagedBlock(content) {
  const pattern = /# >>> commit-queue >>>[\s\S]*?# <<< commit-queue <<<\n?/;
  if (pattern.test(content)) {
    return content.replace(pattern, managedBlock);
  }
  const separator = content.endsWith("\n") || content.length === 0 ? "" : "\n";
  return `${content}${separator}\n${managedBlock}`;
}
