import { isConfigReadOnly } from "../command-policy.js";
import { errorPayload, exitWithResult, fail } from "../errors.js";
import { runGit } from "../git-runtime.js";

export function handleConfig(realGit: string, repo: string, originalArgs: string[], args: string[]): void {
  if (isConfigReadOnly(args)) {
    exitWithResult(runGit(realGit, originalArgs));
  }

  fail(errorPayload({
    code: "COMMIT_QUEUE_CONFIG_MUTATION_BLOCKED",
    title: "Git config mutation blocked",
    detail: "Git config writes are blocked in protected mode.",
    context: { command: "config", args, repo },
    suggestions: ["Use read-only config queries, or ask the human if Git config must change."],
    retriable: false,
  }));
}
