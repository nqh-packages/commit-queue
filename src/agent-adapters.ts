import {
  resolveLatestCursorSessionId,
  sessionIdFromTranscriptPath,
} from "./cursor-session.js";
import type { AgentIdentity } from "./types.js";

const EXPLICIT_AGENT_ENV = "COMMIT_QUEUE_AGENT";
const EXPLICIT_AGENT_SESSION_ENV = "COMMIT_QUEUE_AGENT_SESSION";
const EXPLICIT_AGENT_ENV_PAIR = [
  EXPLICIT_AGENT_ENV,
  EXPLICIT_AGENT_SESSION_ENV,
] as const;
const PI_AGENT_ENV = "PI_CODING_AGENT";
const PI_SESSION_ENV = "PI_SESSION_ID";
const PI_CODING_AGENT_SESSION_ENV = "PI_CODING_AGENT_SESSION";
const CURSOR_AGENT_SESSION_ENV = "CURSOR_AGENT_SESSION_ID";
const CURSOR_CONVERSATION_ENV = "CURSOR_CONVERSATION_ID";
const CURSOR_TRANSCRIPT_PATH_ENV = "CURSOR_TRANSCRIPT_PATH";
const CURSOR_PROJECT_DIR_ENV = "CURSOR_PROJECT_DIR";
const CURSOR_AGENT_ENV = "CURSOR_AGENT";
const CURSOR_TRACE_ID_ENV = "CURSOR_TRACE_ID";
const CURSOR_INVOKED_AS_ENV = "CURSOR_INVOKED_AS";
const CURSOR_TRANSCRIPT_FS_DETECTED_FROM = "CURSOR_TRANSCRIPT_FS";

export type AgentIdentityDetectContext = {
  /** Git repo root when known (improves Cursor filesystem fallback). */
  repo?: string;
};

export type AgentIdentityAdapterDetection =
  | {
      status: "detected";
      adapter: string;
      agent: AgentIdentity;
    }
  | {
      status: "blocked";
      adapter: string;
      reason: string;
      context: Record<string, unknown>;
    }
  | {
      status: "not_detected";
    };

export type AgentIdentityAdapter = {
  name: string;
  env: readonly string[];
  detect: (
    env: NodeJS.ProcessEnv,
    context?: AgentIdentityDetectContext,
  ) => AgentIdentityAdapterDetection;
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
  detect: detectEnvBackedAgent("codex", "CODEX_THREAD_ID"),
};

const opencodeAgentAdapter: AgentIdentityAdapter = {
  name: "opencode",
  env: ["OPENCODE_SESSION_ID"],
  detect: detectEnvBackedAgent("opencode", "OPENCODE_SESSION_ID"),
};

const piAgentAdapter: AgentIdentityAdapter = {
  name: "pi",
  env: [PI_SESSION_ENV, PI_CODING_AGENT_SESSION_ENV, PI_AGENT_ENV],
  detect: (env) => {
    const nativeSessionId = optionalEnv(env, PI_SESSION_ENV);
    const fallbackSessionId = optionalEnv(env, PI_CODING_AGENT_SESSION_ENV);
    const sessionId = nativeSessionId ?? fallbackSessionId;
    const isPi = optionalEnv(env, PI_AGENT_ENV);

    if (sessionId) {
      return {
        status: "detected",
        adapter: "pi",
        agent: {
          name: "pi",
          sessionId: `pi-${sessionId}`,
          detectedFrom: nativeSessionId
            ? PI_SESSION_ENV
            : PI_CODING_AGENT_SESSION_ENV,
        },
      };
    }

    if (!isPi) return { status: "not_detected" };

    return {
      status: "blocked",
      adapter: "pi",
      reason: "pi_session_id_missing",
      context: {
        required_env: [PI_SESSION_ENV],
        received_env: [PI_AGENT_ENV],
      },
    };
  },
};

const cursorAgentAdapter: AgentIdentityAdapter = {
  name: "cursor",
  env: [
    CURSOR_AGENT_SESSION_ENV,
    CURSOR_CONVERSATION_ENV,
    CURSOR_TRANSCRIPT_PATH_ENV,
    CURSOR_PROJECT_DIR_ENV,
    CURSOR_AGENT_ENV,
    CURSOR_TRACE_ID_ENV,
    CURSOR_INVOKED_AS_ENV,
  ],
  detect: (env, context = {}) => {
    const hookSession =
      optionalEnv(env, CURSOR_AGENT_SESSION_ENV) ??
      optionalEnv(env, CURSOR_CONVERSATION_ENV);
    const transcriptPath = optionalEnv(env, CURSOR_TRANSCRIPT_PATH_ENV);
    const transcriptSession = transcriptPath
      ? sessionIdFromTranscriptPath(transcriptPath)
      : null;
    const sessionId = hookSession ?? transcriptSession;

    if (sessionId) {
      const detectedFrom = hookSession
        ? optionalEnv(env, CURSOR_AGENT_SESSION_ENV)
          ? CURSOR_AGENT_SESSION_ENV
          : CURSOR_CONVERSATION_ENV
        : CURSOR_TRANSCRIPT_PATH_ENV;

      return {
        status: "detected",
        adapter: "cursor",
        agent: {
          name: "cursor",
          sessionId: `cursor-${sessionId}`,
          detectedFrom,
        },
      };
    }

    if (!isCursorAgentShell(env)) return { status: "not_detected" };

    const repoRoot =
      context.repo ?? optionalEnv(env, CURSOR_PROJECT_DIR_ENV) ?? process.cwd();
    const filesystemSession = resolveLatestCursorSessionId(repoRoot);
    if (filesystemSession) {
      return {
        status: "detected",
        adapter: "cursor",
        agent: {
          name: "cursor",
          sessionId: `cursor-${filesystemSession}`,
          detectedFrom: CURSOR_TRANSCRIPT_FS_DETECTED_FROM,
        },
      };
    }

    return {
      status: "blocked",
      adapter: "cursor",
      reason: "cursor_session_id_missing",
      context: {
        required_env: [CURSOR_AGENT_SESSION_ENV],
        received_env: receivedCursorShellEnv(env),
        install_hint:
          "Merge integrations/cursor/hooks.json sessionStart hook (see integrations/cursor/README.md) or export CURSOR_AGENT_SESSION_ID before git getID.",
      },
    };
  },
};

export const agentIdentityAdapters: readonly AgentIdentityAdapter[] = [
  explicitAgentAdapter,
  codexAgentAdapter,
  opencodeAgentAdapter,
  piAgentAdapter,
  cursorAgentAdapter,
];

export function detectAgentIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  context: AgentIdentityDetectContext = {},
): AgentIdentityAdapterDetection {
  for (const adapter of agentIdentityAdapters) {
    const detection = adapter.detect(env, context);
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

function detectEnvBackedAgent(
  adapter: string,
  envName: string,
): AgentIdentityAdapter["detect"] {
  return (env) => {
    const sessionId = optionalEnv(env, envName);
    if (!sessionId) return { status: "not_detected" };

    return {
      status: "detected",
      adapter,
      agent: {
        name: adapter,
        sessionId: `${adapter}-${sessionId}`,
        detectedFrom: envName,
      },
    };
  };
}

function receivedExplicitEnv(
  explicitAgent: string | null,
  explicitSession: string | null,
): string[] {
  return [
    ...(explicitAgent ? [EXPLICIT_AGENT_ENV] : []),
    ...(explicitSession ? [EXPLICIT_AGENT_SESSION_ENV] : []),
  ];
}

function missingExplicitEnv(
  explicitAgent: string | null,
  explicitSession: string | null,
): string[] {
  return [
    ...(explicitAgent ? [] : [EXPLICIT_AGENT_ENV]),
    ...(explicitSession ? [] : [EXPLICIT_AGENT_SESSION_ENV]),
  ];
}

function isCursorAgentShell(env: NodeJS.ProcessEnv): boolean {
  if (optionalEnv(env, CURSOR_AGENT_ENV)) return true;
  if (optionalEnv(env, CURSOR_TRACE_ID_ENV)) return true;
  if (optionalEnv(env, CURSOR_INVOKED_AS_ENV) === "agent") return true;
  if (optionalEnv(env, CURSOR_TRANSCRIPT_PATH_ENV)) return true;
  return false;
}

function receivedCursorShellEnv(env: NodeJS.ProcessEnv): string[] {
  return [
    CURSOR_AGENT_ENV,
    CURSOR_TRACE_ID_ENV,
    CURSOR_INVOKED_AS_ENV,
    CURSOR_TRANSCRIPT_PATH_ENV,
  ].filter((name) => Boolean(optionalEnv(env, name)));
}
