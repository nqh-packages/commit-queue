import { detectAgentIdentity } from "../agent-identity.js";
import { createCommitQueueSession } from "../session-bootstrap.js";
import { escapeDoubleQuoted } from "../text.js";

export function createSession(realGit: string, repo: string): void {
  const agent = detectAgentIdentity("getID", repo);
  const session = createCommitQueueSession(realGit, repo, agent);

  process.stdout.write(
    [
      `export COMMIT_QUEUE_ID="${escapeDoubleQuoted(session.id)}"`,
      `export COMMIT_QUEUE_REPO="${escapeDoubleQuoted(repo)}"`,
      `export COMMIT_QUEUE_AGENT="${escapeDoubleQuoted(agent.name)}"`,
      `export COMMIT_QUEUE_AGENT_SESSION="${escapeDoubleQuoted(agent.sessionId)}"`,
      "",
    ].join("\n"),
  );
}
