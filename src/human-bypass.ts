import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    const message = messageSourceAt(sanitizedArgs, index);
    if (!message) continue;

    const stripped = stripMatchingSecretLine(message.content, expectedHash);
    if (!stripped.matched) continue;

    if (message.kind === "joined-message") {
      sanitizedArgs[index] = `${message.prefix}${stripped.value}`;
    } else if (message.kind === "message") {
      sanitizedArgs[index + 1] = stripped.value;
    } else if (message.kind === "joined-file") {
      sanitizedArgs[index] = `${message.prefix}${writeSanitizedMessageFile(stripped.value)}`;
    } else {
      sanitizedArgs[index + 1] = writeSanitizedMessageFile(stripped.value);
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

type MessageSource =
  | { kind: "message"; content: string }
  | { kind: "joined-message"; content: string; prefix: string }
  | { kind: "file"; content: string }
  | { kind: "joined-file"; content: string; prefix: string };

function messageSourceAt(
  args: string[],
  index: number,
): MessageSource | null {
  const arg = args[index] || "";
  if ((arg === "-m" || arg === "--message") && index + 1 < args.length) {
    return { kind: "message", content: args[index + 1] || "" };
  }

  if (arg.startsWith("--message=")) {
    return { kind: "joined-message", content: arg.slice("--message=".length), prefix: "--message=" };
  }

  if ((arg === "-F" || arg === "--file") && index + 1 < args.length) {
    return messageFileSource(args[index + 1] || "", "file");
  }

  if (arg.startsWith("--file=")) {
    return messageFileSource(arg.slice("--file=".length), "joined-file");
  }

  return null;
}

function messageFileSource(filePath: string, kind: "file" | "joined-file"): MessageSource | null {
  if (!filePath || filePath === "-") return null;

  try {
    const content = readFileSync(path.resolve(filePath), "utf8");
    if (kind === "joined-file") {
      return { kind, content, prefix: "--file=" };
    }
    return { kind, content };
  } catch {
    return null;
  }
}

function writeSanitizedMessageFile(message: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "commit-queue-message-"));
  const filePath = path.join(dir, "COMMIT_EDITMSG");
  writeFileSync(filePath, message);
  return filePath;
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
