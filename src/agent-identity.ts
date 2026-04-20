import { errorPayload, fail } from "./errors.js";
import type { AgentIdentity, CommitQueueSession } from "./types.js";

const EXPLICIT_AGENT_ENV = "COMMIT_QUEUE_AGENT";
const EXPLICIT_AGENT_SESSION_ENV = "COMMIT_QUEUE_AGENT_SESSION";
const CODEX_THREAD_ENV = "CODEX_THREAD_ID";
const OPENCODE_SESSION_ENV = "OPENCODE_SESSION_ID";
const MAX_AGENT_SESSION_LENGTH = 256;

export function detectAgentIdentity(command: string, repo: string): AgentIdentity {
  const explicitAgent = optionalEnv(EXPLICIT_AGENT_ENV);
  const explicitSession = optionalEnv(EXPLICIT_AGENT_SESSION_ENV);
  if (explicitAgent || explicitSession) {
    if (!explicitAgent || !explicitSession) {
      fail(agentIdentityRequiredError(command, repo, {
        reason: "explicit_agent_identity_incomplete",
        required_env: [EXPLICIT_AGENT_ENV, EXPLICIT_AGENT_SESSION_ENV],
      }));
    }

    return validateAgentIdentity(command, repo, {
      name: explicitAgent,
      sessionId: explicitSession,
      detectedFrom: EXPLICIT_AGENT_ENV,
    });
  }

  const codexThreadId = optionalEnv(CODEX_THREAD_ENV);
  if (codexThreadId) {
    return validateAgentIdentity(command, repo, {
      name: "codex",
      sessionId: `codex-${codexThreadId}`,
      detectedFrom: CODEX_THREAD_ENV,
    });
  }

  const opencodeSessionId = optionalEnv(OPENCODE_SESSION_ENV);
  if (opencodeSessionId) {
    return validateAgentIdentity(command, repo, {
      name: "opencode",
      sessionId: `opencode-${opencodeSessionId}`,
      detectedFrom: OPENCODE_SESSION_ENV,
    });
  }

  fail(agentIdentityRequiredError(command, repo, {
    checked_env: [
      EXPLICIT_AGENT_ENV,
      EXPLICIT_AGENT_SESSION_ENV,
      CODEX_THREAD_ENV,
      OPENCODE_SESSION_ENV,
    ],
  }));
}

export function requireAgentIdentity(command: string, repo: string, session: CommitQueueSession): AgentIdentity {
  if (!session.agent) {
    fail(agentIdentityRequiredError(command, repo, {
      session: session.id,
      reason: "session_missing_agent_metadata",
    }));
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
    fail(agentIdentityRequiredError(command, repo, {
      session,
      reason: "invalid_agent_identity",
      agent_name_valid: Boolean(name),
      agent_session_valid: Boolean(sessionId),
      detected_from_valid: Boolean(detectedFrom),
    }));
  }

  return { name, sessionId, detectedFrom };
}

function agentIdentityRequiredError(command: string, repo: string, context: Record<string, unknown>) {
  return errorPayload({
    code: "COMMIT_QUEUE_AGENT_ID_REQUIRED",
    title: "Coding agent identity required",
    detail: "Protected commit-queue sessions require a coding agent identity so commits can be traced back to the agent session that produced them.",
    context: { command, repo, cwd: process.cwd(), ...context },
    suggestions: [
      "Run `git getID` from a supported coding agent session.",
      "For unsupported agents, set COMMIT_QUEUE_AGENT and COMMIT_QUEUE_AGENT_SESSION before running `git getID`.",
    ],
    retriable: true,
  });
}

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function normalizeAgentName(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(normalized)) return null;
  return normalized;
}

function normalizeAgentSession(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_AGENT_SESSION_LENGTH) return null;
  if (/[\r\n\0]/.test(normalized)) return null;
  return normalized;
}

function normalizeDetectedFrom(value: string): string | null {
  const normalized = value.trim();
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(normalized)) return null;
  return normalized;
}
