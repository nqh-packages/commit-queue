import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { ensureStateDirs, statePaths } from "./session-store.js";

const LOCAL_RUNTIME_CONFIG = ".runtime-local.json";

export type HumanBypassConfig = {
  humanNoVerifyPhraseHash?: string;
};

export type HumanNoVerifyBypass = {
  sanitizedArgs: string[];
};

export function detectHumanNoVerifyBypass(args: string[]): HumanNoVerifyBypass | null {
  const config = readHumanBypassConfig();
  const expectedHash = config?.humanNoVerifyPhraseHash;
  if (!expectedHash) return null;

  const sanitizedArgs = [...args];

  for (let index = 0; index < sanitizedArgs.length; index += 1) {
    const arg = sanitizedArgs[index] || "";
    const message = messageValueAt(sanitizedArgs, index);
    if (!message) continue;

    const stripped = stripMatchingSecretLine(message.value, expectedHash);
    if (!stripped.matched) continue;

    if (message.joined) {
      sanitizedArgs[index] = `${message.prefix}${stripped.value}`;
    } else {
      sanitizedArgs[index + 1] = stripped.value;
    }

    return { sanitizedArgs };
  }

  return null;
}

export function writeHumanNoVerifyBypassEvent(repo: string): void {
  ensureStateDirs();
  appendFileSync(
    path.join(statePaths().logs, "events.jsonl"),
    `${JSON.stringify({
      type: "commit_queue.human_no_verify_bypass",
      repo,
      command: "commit",
      timestamp: new Date().toISOString(),
    })}\n`,
  );
}

function readHumanBypassConfig(): HumanBypassConfig | null {
  const configPath = path.join(statePaths().root, LOCAL_RUNTIME_CONFIG);
  if (!existsSync(configPath)) return null;

  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as HumanBypassConfig;
  } catch {
    return null;
  }
}

function messageValueAt(
  args: string[],
  index: number,
): { value: string; joined: false } | { value: string; joined: true; prefix: string } | null {
  const arg = args[index] || "";
  if ((arg === "-m" || arg === "--message") && index + 1 < args.length) {
    return { value: args[index + 1] || "", joined: false };
  }

  if (arg.startsWith("--message=")) {
    return { value: arg.slice("--message=".length), joined: true, prefix: "--message=" };
  }

  return null;
}

function stripMatchingSecretLine(message: string, expectedHash: string): { matched: boolean; value: string } {
  const lines = message.split(/\r?\n/);
  const remaining = lines.filter((line) => sha256(line.trim()) !== expectedHash);
  return {
    matched: remaining.length !== lines.length,
    value: remaining.join("\n"),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
