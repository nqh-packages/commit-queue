import type { ErrorPayload, GitResult } from "./types.js";

type ErrorInput = {
  code: string;
  title: string;
  detail: string;
  context: Record<string, unknown>;
  suggestions: string[];
  retriable: boolean;
};

export function exitWithResult(result: GitResult): never {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

export function fail(payload: ErrorPayload): never {
  if (process.env.COMMIT_QUEUE_JSON === "1") {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(
      [
        `[commit-queue] blocked: ${payload.detail}`,
        "",
        `error_code: ${payload.error_code}`,
        `retriable: ${String(payload.retriable)}`,
        "context:",
        ...formatContext(payload.context),
        ...payload.suggestions.map((suggestion) => `suggestion: ${suggestion}`),
        "",
      ].join("\n"),
    );
  }
  process.exit(payload.status >= 500 ? 1 : 2);
}

export function errorPayload({
  code,
  title,
  detail,
  context,
  suggestions,
  retriable,
}: ErrorInput): ErrorPayload {
  return {
    type: `https://commit-queue.local/errors/${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status: 409,
    detail,
    error_code: code,
    timestamp: new Date().toISOString(),
    context,
    retriable,
    suggestions,
  };
}

function formatContext(context: Record<string, unknown>): string[] {
  return JSON.stringify(context, null, 2)
    .split("\n")
    .map((line) => `  ${line}`);
}
