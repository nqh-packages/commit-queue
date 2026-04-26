import type { Invocation } from "../types.js";

const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

const GLOBAL_OPTIONS_WITHOUT_VALUE = new Set([
  "-P",
  "-p",
  "--bare",
  "--glob-pathspecs",
  "--icase-pathspecs",
  "--literal-pathspecs",
  "--no-optional-locks",
  "--no-pager",
  "--no-replace-objects",
  "--noglob-pathspecs",
  "--paginate",
]);

const JOINED_GLOBAL_OPTION_PREFIXES = [
  "--config-env=",
  "--exec-path=",
  "--git-dir=",
  "--namespace=",
  "--super-prefix=",
  "--work-tree=",
];

export function parseInvocation(args: string[]): Invocation {
  const globalArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      globalArgs.push(arg);
      if (index + 1 < args.length) {
        globalArgs.push(args[index + 1] ?? "");
        index += 1;
      }
      continue;
    }

    if (isJoinedGlobalOption(arg) || GLOBAL_OPTIONS_WITHOUT_VALUE.has(arg)) {
      globalArgs.push(arg);
      continue;
    }

    return {
      globalArgs,
      command: arg,
      commandArgs: args.slice(index + 1),
    };
  }

  return {
    globalArgs,
    command: null,
    commandArgs: [],
  };
}

export function hasGlobalConfigOverride(globalArgs: string[]): boolean {
  return globalArgs.some(
    (arg) =>
      arg === "-c" ||
      arg.startsWith("-c") ||
      arg === "--config-env" ||
      arg.startsWith("--config-env="),
  );
}

function isJoinedGlobalOption(arg: string): boolean {
  return (
    JOINED_GLOBAL_OPTION_PREFIXES.some((prefix) => arg.startsWith(prefix)) ||
    /^-c[^=]+=.*/.test(arg)
  );
}
