import assert from "node:assert/strict";
import test from "node:test";
import {
  agentIdentityAdapters,
  detectAgentIdentityFromEnv,
  checkedAgentIdentityEnv,
  supportedAgentAdapters,
} from "../dist/agent-adapters.js";

test("agent adapter registry keeps known platforms data-driven", () => {
  assert.deepEqual(supportedAgentAdapters(), ["explicit", "codex", "opencode"]);
  assert.deepEqual(checkedAgentIdentityEnv(), [
    "COMMIT_QUEUE_AGENT",
    "COMMIT_QUEUE_AGENT_SESSION",
    "CODEX_THREAD_ID",
    "OPENCODE_SESSION_ID",
  ]);
  assert.equal(agentIdentityAdapters.length, 3);
});

test("explicit agent adapter has priority over platform-specific detection", () => {
  const detection = detectAgentIdentityFromEnv({
    COMMIT_QUEUE_AGENT: "custom-agent",
    COMMIT_QUEUE_AGENT_SESSION: "custom-session",
    CODEX_THREAD_ID: "codex-thread",
  });

  assert.deepEqual(detection, {
    status: "detected",
    adapter: "explicit",
    agent: {
      name: "custom-agent",
      sessionId: "custom-session",
      detectedFrom: "COMMIT_QUEUE_AGENT",
    },
  });
});

test("explicit agent adapter reports incomplete explicit identity", () => {
  const detection = detectAgentIdentityFromEnv({
    COMMIT_QUEUE_AGENT: "custom-agent",
    COMMIT_QUEUE_AGENT_SESSION: "",
  });

  assert.deepEqual(detection, {
    status: "blocked",
    adapter: "explicit",
    reason: "explicit_agent_identity_incomplete",
    context: {
      required_env: ["COMMIT_QUEUE_AGENT", "COMMIT_QUEUE_AGENT_SESSION"],
      received_env: ["COMMIT_QUEUE_AGENT"],
      missing_env: ["COMMIT_QUEUE_AGENT_SESSION"],
    },
  });
});

test("explicit agent adapter reports when session id is provided without agent name", () => {
  const detection = detectAgentIdentityFromEnv({
    COMMIT_QUEUE_AGENT: "",
    COMMIT_QUEUE_AGENT_SESSION: "custom-session",
  });

  assert.deepEqual(detection, {
    status: "blocked",
    adapter: "explicit",
    reason: "explicit_agent_identity_incomplete",
    context: {
      required_env: ["COMMIT_QUEUE_AGENT", "COMMIT_QUEUE_AGENT_SESSION"],
      received_env: ["COMMIT_QUEUE_AGENT_SESSION"],
      missing_env: ["COMMIT_QUEUE_AGENT"],
    },
  });
});
