import {
  checkedAgentIdentityEnv,
  detectAgentIdentityFromEnv,
  supportedAgentAdapters,
} from "./agent-adapters.js";
import { errorPayload, fail } from "./errors.js";
import type { AgentIdentity, CommitQueueSession } from "./types.js";

const MAX_AGENT_SESSION_LENGTH = 256;

export function detectAgentIdentity(
  command: string,
  repo: string,
): AgentIdentity {
  const detection = detectAgentIdentityFromEnv();
  if (detection.status === "detected") {
    return validateAgentIdentity(command, repo, detection.agent);
  }

  if (detection.status === "blocked") {
    fail(
      agentIdentityRequiredError(command, repo, {
        adapter: detection.adapter,
        reason: detection.reason,
        ...detection.context,
      }),
    );
  }

  fail(agentIdentityRequiredError(command, repo, {}));
}

export function requireAgentIdentity(
  command: string,
  repo: string,
  session: CommitQueueSession,
): AgentIdentity {
  if (!session.agent) {
    fail(
      agentIdentityRequiredError(command, repo, {
        session: session.id,
        reason: "session_missing_agent_metadata",
      }),
    );
  }

  return validateAgentIdentity(command, repo, session.agent, session.id);
}

function validateAgentIdentity(
  command: string,
  repo: string,
  agent: AgentIdentity,
  session?: string,
): AgentIdentity {
  const name = normalizeAgentName(agent.name);
  const sessionId = normalizeAgentSession(agent.sessionId);
  const detectedFrom = normalizeDetectedFrom(agent.detectedFrom);

  if (!name || !sessionId || !detectedFrom) {
    fail(
      agentIdentityRequiredError(command, repo, {
        session,
        reason: "invalid_agent_identity",
        agent_name_valid: Boolean(name),
        agent_session_valid: Boolean(sessionId),
        detected_from_valid: Boolean(detectedFrom),
      }),
    );
  }

  return { name, sessionId, detectedFrom };
}

function agentIdentityRequiredError(
  command: string,
  repo: string,
  context: Record<string, unknown>,
) {
  return errorPayload({
    code: "COMMIT_QUEUE_AGENT_ID_REQUIRED",
    title: "Coding agent identity required",
    detail: agentIdentityRequiredDetail(context),
    context: {
      command,
      repo,
      cwd: process.cwd(),
      supported_agents: supportedAgentAdapters(),
      checked_env: checkedAgentIdentityEnv(),
      examples: agentIdentityRecoveryExamples(),
      ...context,
    },
    suggestions: agentIdentityRequiredSuggestions(context),
    retriable: true,
  });
}

function agentIdentityRequiredDetail(context: Record<string, unknown>): string {
  const missingEnv = context.missing_env;
  const receivedEnv = context.received_env;
  if (
    Array.isArray(missingEnv) &&
    Array.isArray(receivedEnv) &&
    missingEnv.includes("COMMIT_QUEUE_AGENT") &&
    receivedEnv.includes("COMMIT_QUEUE_AGENT_SESSION")
  ) {
    return "COMMIT_QUEUE_AGENT_SESSION alone is not enough. Protected commit-queue sessions also require COMMIT_QUEUE_AGENT so commit attribution records both the coding platform and the platform session id.";
  }

  if (
    Array.isArray(missingEnv) &&
    Array.isArray(receivedEnv) &&
    missingEnv.includes("COMMIT_QUEUE_AGENT_SESSION") &&
    receivedEnv.includes("COMMIT_QUEUE_AGENT")
  ) {
    return "COMMIT_QUEUE_AGENT is set, but COMMIT_QUEUE_AGENT_SESSION is missing. Protected commit-queue sessions require both values so commit attribution records the coding platform and the platform session id.";
  }

  return "Protected commit-queue sessions require a coding agent identity so commits can be traced back to the agent session that produced them.";
}

function agentIdentityRequiredSuggestions(
  context: Record<string, unknown>,
): string[] {
  if (context.reason === "explicit_agent_identity_incomplete") {
    return [
      ...agentIdentityRecoveryExamples().map(formatAgentIdentityExample),
      "If this agent has a supported built-in adapter, run `git getID` from that agent environment without overriding COMMIT_QUEUE_AGENT or COMMIT_QUEUE_AGENT_SESSION.",
    ];
  }

  return [
    "Run `git getID` from a supported coding agent session.",
    ...agentIdentityRecoveryExamples().map(formatAgentIdentityExample),
  ];
}

function agentIdentityRecoveryExamples(): Array<Record<string, string>> {
  return [
    {
      label: "unsupported agent",
      description:
        "Set both explicit identity variables before starting a commit-queue session.",
      command:
        'export COMMIT_QUEUE_AGENT="claude-code"; export COMMIT_QUEUE_AGENT_SESSION="claude-code-abc123"; eval "$(git getID)"',
    },
    {
      label: "Codex",
      description: "Run from Codex so CODEX_THREAD_ID is present.",
      command: 'eval "$(git getID)"',
      detected_env: "CODEX_THREAD_ID",
    },
    {
      label: "OpenCode",
      description: "Run from OpenCode so OPENCODE_SESSION_ID is present.",
      command: 'eval "$(git getID)"',
      detected_env: "OPENCODE_SESSION_ID",
    },
  ];
}

function formatAgentIdentityExample(example: Record<string, string>): string {
  const detectedEnv = example.detected_env
    ? ` Detected env: ${example.detected_env}.`
    : "";
  return `Example ${example.label}: ${example.description}${detectedEnv} Run: \`${example.command}\`.`;
}

function normalizeAgentName(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(normalized)) return null;
  return normalized;
}

function normalizeAgentSession(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_AGENT_SESSION_LENGTH) return null;
  if (
    normalized.includes("\r") ||
    normalized.includes("\n") ||
    normalized.includes(String.fromCharCode(0))
  )
    return null;
  return normalized;
}

function normalizeDetectedFrom(value: string): string | null {
  const normalized = value.trim();
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(normalized)) return null;
  return normalized;
}
