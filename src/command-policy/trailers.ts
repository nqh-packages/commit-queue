import type { ReservedCommitTrailer } from "./types.js";

const RESERVED_TRAILER_KEYS = new Set([
  "commit-queue-session",
  "coding-agent",
  "coding-agent-session",
]);

export function firstReservedCommitTrailer(
  args: string[],
): ReservedCommitTrailer | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || "";
    let trailerValue: string | null = null;

    if (arg === "--trailer") {
      trailerValue = args[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--trailer=")) {
      trailerValue = arg.slice("--trailer=".length);
    }

    const key = trailerValue ? reservedTrailerKey(trailerValue) : null;
    if (key) return { key, arg: trailerValue || arg };
  }

  return null;
}

function reservedTrailerKey(value: string): string | null {
  const key = value.split(/[:=]/, 1)[0]?.trim().toLowerCase();
  if (!key) return null;
  return RESERVED_TRAILER_KEYS.has(key) ? key : null;
}
