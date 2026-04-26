import type { UnsafeConfigMutation } from "./types.js";

const CONFIG_READ_ONLY_ARGS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
  "-l",
  "--show-origin",
  "--show-scope",
  "--name-only",
]);

export function firstUnsafeConfigMutation(
  args: string[],
): UnsafeConfigMutation | null {
  if (args.some((arg) => arg === "--edit" || arg === "-e")) {
    return { key: "--edit", reason: "config_editor" };
  }

  for (const arg of args) {
    const key = configKeyFromArg(arg);
    if (!key) continue;

    const normalized = key.toLowerCase();
    if (normalized === "core.hookspath") {
      return { key, reason: "hooks_path" };
    }
    if (normalized.startsWith("hook.")) {
      return { key, reason: "hook_config" };
    }
  }

  return null;
}

export function isConfigReadOnly(args: string[]): boolean {
  if (args.length === 1 && !args[0]?.startsWith("-")) return true;
  return args.some((arg) => CONFIG_READ_ONLY_ARGS.has(arg));
}

function configKeyFromArg(arg: string): string | null {
  if (!arg || arg === "--") return null;
  if (arg.startsWith("--")) {
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex === -1) return null;
    return arg.slice(equalsIndex + 1);
  }
  if (arg.startsWith("-")) return null;
  return arg.split(/[=\s]/, 1)[0] || null;
}
