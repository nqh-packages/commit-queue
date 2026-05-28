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
    "cursor",
  ]);
  assert.deepEqual(checkedAgentIdentityEnv(), [
    "COMMIT_QUEUE_AGENT",
    "COMMIT_QUEUE_AGENT_SESSION",
    "CODEX_THREAD_ID",
    "OPENCODE_SESSION_ID",
    "PI_SESSION_ID",
    "PI_CODING_AGENT_SESSION",
    "PI_CODING_AGENT",
    "CURSOR_AGENT_SESSION_ID",
    "CURSOR_CONVERSATION_ID",
    "CURSOR_TRANSCRIPT_PATH",
    "CURSOR_PROJECT_DIR",
    "CURSOR_AGENT",
    "CURSOR_TRACE_ID",
    "CURSOR_INVOKED_AS",
  ]);
  assert.equal(agentIdentityAdapters.length, 5);
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

const CURSOR_TEST_SESSION_ID = "0e39f2c2-f468-4628-8d58-c5e21a6c2ebf";

test("cursor adapter detects session id from hook env", () => {
  const detection = detectAgentIdentityFromEnv({
    CURSOR_AGENT: "1",
    CURSOR_AGENT_SESSION_ID: CURSOR_TEST_SESSION_ID,
  });

  assert.deepEqual(detection, {
    status: "detected",
    adapter: "cursor",
    agent: {
      name: "cursor",
      sessionId: `cursor-${CURSOR_TEST_SESSION_ID}`,
      detectedFrom: "CURSOR_AGENT_SESSION_ID",
    },
  });
});

test("cursor adapter parses session id from transcript path env", () => {
  const detection = detectAgentIdentityFromEnv({
    CURSOR_TRACE_ID: "trace",
    CURSOR_TRANSCRIPT_PATH: `/Users/huy/.cursor/projects/Volumes-BIWIN-CODES-company-runner/agent-transcripts/${CURSOR_TEST_SESSION_ID}/${CURSOR_TEST_SESSION_ID}.jsonl`,
  });

  assert.deepEqual(detection, {
    status: "detected",
    adapter: "cursor",
    agent: {
      name: "cursor",
      sessionId: `cursor-${CURSOR_TEST_SESSION_ID}`,
      detectedFrom: "CURSOR_TRANSCRIPT_PATH",
    },
  });
});

test("cursor adapter blocks cursor shells without a resolvable session id", () => {
  const detection = detectAgentIdentityFromEnv(
    {
      CURSOR_AGENT: "1",
    },
    { repo: "/tmp/nonexistent-cursor-project-for-commit-queue" },
  );

  assert.equal(detection.status, "blocked");
  assert.equal(detection.adapter, "cursor");
  assert.equal(detection.reason, "cursor_session_id_missing");
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
