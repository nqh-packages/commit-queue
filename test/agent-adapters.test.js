import assert from "node:assert/strict";
import test from "node:test";
import {
  agentIdentityAdapters,
  checkedAgentIdentityEnv,
  detectAgentIdentityFromEnv,
  supportedAgentAdapters,
} from "../dist/agent-adapters.js";

const PI_TEST_SESSION_ID = "019dcbcc-b152-70a0-b167-aeaaaf7a9b32";
const PI_COMMIT_QUEUE_SESSION_ID = `pi-${PI_TEST_SESSION_ID}`;

test("agent adapter registry keeps known platforms data-driven", () => {
  assert.deepEqual(supportedAgentAdapters(), [
    "explicit",
    "codex",
    "opencode",
    "pi",
  ]);
  assert.deepEqual(checkedAgentIdentityEnv(), [
    "COMMIT_QUEUE_AGENT",
    "COMMIT_QUEUE_AGENT_SESSION",
    "CODEX_THREAD_ID",
    "OPENCODE_SESSION_ID",
    "PI_SESSION_ID",
    "PI_CODING_AGENT_SESSION",
    "PI_CODING_AGENT",
  ]);
  assert.equal(agentIdentityAdapters.length, 4);
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

test("pi adapter detects real pi session ids from platform env", () => {
  const detection = detectAgentIdentityFromEnv({
    PI_CODING_AGENT: "true",
    PI_SESSION_ID: PI_TEST_SESSION_ID,
  });

  assert.deepEqual(detection, {
    status: "detected",
    adapter: "pi",
    agent: {
      name: "pi",
      sessionId: PI_COMMIT_QUEUE_SESSION_ID,
      detectedFrom: "PI_SESSION_ID",
    },
  });
});

test("pi adapter blocks pi shells that do not expose a session id", () => {
  const detection = detectAgentIdentityFromEnv({
    PI_CODING_AGENT: "true",
  });

  assert.deepEqual(detection, {
    status: "blocked",
    adapter: "pi",
    reason: "pi_session_id_missing",
    context: {
      required_env: ["PI_SESSION_ID"],
      received_env: ["PI_CODING_AGENT"],
    },
  });
});
