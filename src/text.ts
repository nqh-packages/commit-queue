import { createHash } from "node:crypto";

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function timestampId(): string {
  return new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
}

export function escapeDoubleQuoted(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")
    .replaceAll('"', '\\"');
}
