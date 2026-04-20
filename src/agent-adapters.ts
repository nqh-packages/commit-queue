import type { AgentIdentity } from "./types.js";

const EXPLICIT_AGENT_ENV = "COMMIT_QUEUE_AGENT";
const EXPLICIT_AGENT_SESSION_ENV = "COMMIT_QUEUE_AGENT_SESSION";
const EXPLICIT_AGENT_ENV_PAIR = [EXPLICIT_AGENT_ENV, EXPLICIT_AGENT_SESSION_ENV] as const;

export type AgentIdentityAdapterDetection = {
  status: "detected";
  adapter: string;
  agent: AgentIdentity;
} | {
  status: "blocked";
  adapter: string;
  reason: string;
  context: Record<string, unknown>;
} | {
  status: "not_detected";
};

export type AgentIdentityAdapter = {
  name: string;
  env: readonly string[];
  detect: (env: NodeJS.ProcessEnv) => AgentIdentityAdapterDetection;
};

const explicitAgentAdapter: AgentIdentityAdapter = {
  name: "explicit",
  env: EXPLICIT_AGENT_ENV_PAIR,
  detect: (env) => {
    const explicitAgent = optionalEnv(env, EXPLICIT_AGENT_ENV);
    const explicitSession = optionalEnv(env, EXPLICIT_AGENT_SESSION_ENV);
    if (!explicitAgent && !explicitSession) return { status: "not_detected" };

    if (!explicitAgent || !explicitSession) {
      return {
        status: "blocked",
        adapter: "explicit",
        reason: "explicit_agent_identity_incomplete",
        context: {
          required_env: [...EXPLICIT_AGENT_ENV_PAIR],
          received_env: receivedExplicitEnv(explicitAgent, explicitSession),
          missing_env: missingExplicitEnv(explicitAgent, explicitSession),
        },
      };
    }

    return {
      status: "detected",
      adapter: "explicit",
      agent: {
        name: explicitAgent,
        sessionId: explicitSession,
        detectedFrom: EXPLICIT_AGENT_ENV,
      },
    };
  },
};

const codexAgentAdapter: AgentIdentityAdapter = {
  name: "codex",
  env: ["CODEX_THREAD_ID"],
  detect: (env) => {
    const threadId = optionalEnv(env, "CODEX_THREAD_ID");
    if (!threadId) return { status: "not_detected" };

    return {
      status: "detected",
      adapter: "codex",
      agent: {
        name: "codex",
        sessionId: `codex-${threadId}`,
        detectedFrom: "CODEX_THREAD_ID",
      },
    };
  },
};

const opencodeAgentAdapter: AgentIdentityAdapter = {
  name: "opencode",
  env: ["OPENCODE_SESSION_ID"],
  detect: (env) => {
    const sessionId = optionalEnv(env, "OPENCODE_SESSION_ID");
    if (!sessionId) return { status: "not_detected" };

    return {
      status: "detected",
      adapter: "opencode",
      agent: {
        name: "opencode",
        sessionId: `opencode-${sessionId}`,
        detectedFrom: "OPENCODE_SESSION_ID",
      },
    };
  },
};

export const agentIdentityAdapters: readonly AgentIdentityAdapter[] = [
  explicitAgentAdapter,
  codexAgentAdapter,
  opencodeAgentAdapter,
];

export function detectAgentIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AgentIdentityAdapterDetection {
  for (const adapter of agentIdentityAdapters) {
    const detection = adapter.detect(env);
    if (detection.status !== "not_detected") return detection;
  }

  return { status: "not_detected" };
}

export function supportedAgentAdapters(): string[] {
  return agentIdentityAdapters.map((adapter) => adapter.name);
}

export function checkedAgentIdentityEnv(): string[] {
  return [...new Set(agentIdentityAdapters.flatMap((adapter) => adapter.env))];
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function receivedExplicitEnv(explicitAgent: string | null, explicitSession: string | null): string[] {
  return [
    ...(explicitAgent ? [EXPLICIT_AGENT_ENV] : []),
    ...(explicitSession ? [EXPLICIT_AGENT_SESSION_ENV] : []),
  ];
}

function missingExplicitEnv(explicitAgent: string | null, explicitSession: string | null): string[] {
  return [
    ...(explicitAgent ? [] : [EXPLICIT_AGENT_ENV]),
    ...(explicitSession ? [] : [EXPLICIT_AGENT_SESSION_ENV]),
  ];
}
