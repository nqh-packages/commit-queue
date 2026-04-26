import { existsSync, lstatSync } from "node:fs";
import * as path from "node:path";
import { matchingGitPaths } from "../git-runtime.js";
import type { UnsafeAddPathspec } from "./types.js";

const BROAD_ADD_ARGS = new Set([
  ".",
  ":/",
  ":/*",
  "-A",
  "--all",
  "-u",
  "--update",
  "--pathspec-from-file",
  "--pathspec-file-nul",
]);

const BROAD_ADD_PREFIXES = ["-A", "-u", "--pathspec-from-file="];

export function hasBroadAdd(args: string[]): boolean {
  return args.some(isBroadAddArg);
}

export function explicitPathArgs(args: string[]): string[] {
  return args.filter((arg) => arg !== "--" && !arg.startsWith("-"));
}

export function firstUnsafeAddPathspec(
  realGit: string,
  repo: string,
  pathArgs: string[],
  options: {
    commandCwd?: string;
    pathBaseCwd?: string;
    globalArgs?: string[];
  } = {},
): UnsafeAddPathspec | null {
  const commandCwd = options.commandCwd || repo;
  const pathBaseCwd = options.pathBaseCwd || repo;

  for (const pathArg of pathArgs) {
    if (hasPathspecWildcard(pathArg)) {
      return { path: pathArg, reason: "wildcard" };
    }

    const absolutePath = path.isAbsolute(pathArg)
      ? pathArg
      : path.join(pathBaseCwd, pathArg);
    if (existsSync(absolutePath) && lstatSync(absolutePath).isDirectory()) {
      return { path: pathArg, reason: "directory" };
    }

    const matchOptions: { cwd?: string; globalArgs?: string[] } = {
      cwd: commandCwd,
    };
    if (options.globalArgs) matchOptions.globalArgs = options.globalArgs;
    const matches = matchingGitPaths(realGit, repo, pathArg, matchOptions);
    if (matches.length > 1) {
      return { path: pathArg, reason: "matches_multiple_paths", matches };
    }
  }

  return null;
}

function isBroadAddArg(arg: string): boolean {
  if (BROAD_ADD_ARGS.has(arg)) return true;
  if (BROAD_ADD_PREFIXES.some((prefix) => arg.startsWith(prefix))) return true;
  return isBroadPathspec(arg);
}

function isBroadPathspec(arg: string): boolean {
  const magic = arg.match(/^:\(([^)]*)\)(.*)$/);
  if (!magic) return false;

  const modifiers =
    magic[1]?.split(",").map((modifier) => modifier.trim()) || [];
  const pattern = magic[2] || "";
  return modifiers.includes("glob") && (pattern === "**" || pattern === "**/*");
}

function hasPathspecWildcard(pathspec: string): boolean {
  const withoutMagic = pathspec.replace(/^:\([^)]*\)/, "");
  return /[*?]/.test(withoutMagic);
}
