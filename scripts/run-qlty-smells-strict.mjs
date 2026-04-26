#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const qlty = resolveQlty();
if (!qlty) {
  console.error(
    "[commit-queue] qlty is required for this repository quality gate.",
  );
  console.error("");
  console.error("Install qlty with:");
  console.error("  curl https://qlty.sh | bash");
  process.exit(127);
}

const result = spawnSync(qlty, ["smells", "--all", "--json"], {
  encoding: "utf8",
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const smells = parseSmells(result.stdout || "");
if (smells.length === 0) {
  process.exit(0);
}

console.error(
  `[commit-queue] qlty smells gate failed: ${smells.length} finding(s).`,
);
process.exit(1);

function resolveQlty() {
  if (commandExists("qlty")) return "qlty";

  const localQlty = join(homedir(), ".qlty", "bin", "qlty");
  return existsSync(localQlty) ? localQlty : null;
}

function commandExists(command) {
  const check = spawnSync("sh", ["-c", `command -v ${command}`], {
    stdio: "ignore",
  });
  return check.status === 0;
}

function parseSmells(output) {
  const jsonStart = output.lastIndexOf("\n[");
  const json = output.slice(
    jsonStart === -1 ? output.indexOf("[") : jsonStart + 1,
  );
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("qlty smells JSON output was not an array");
  }
  return parsed;
}
