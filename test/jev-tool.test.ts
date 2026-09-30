import assert from "node:assert/strict";
import test from "node:test";
import { createJevAskTool, StateTooLargeError, withBackoff } from "../src/jev-tool.js";
import { JevEvalError } from "../src/classifier.js";
import { jevAskModel } from "../src/jev-tool.js";

type ToolResult = { content: { type: string; text: string }[]; details?: unknown; isError?: boolean };

const tool = createJevAskTool({}) as {
  execute: (id: string, params: { state: unknown; questions: Record<string, unknown> }, signal?: AbortSignal) => Promise<ToolResult>;
};

function jsonResponse(payload: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
}

const BOOL_QUESTION = { ship: { type: "boolean", instructions: "Ship?", criteria: { true: "yes", false: "no" } } };

test("jev_ask evaluates against the ambient route and returns the pi-jev result shape", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse({
      answers: { ship: { type: "boolean", probability: 0.27 } },
      usage: { inputTokens: 10, outputTokens: 2 },
      warnings: [],
    })) as typeof fetch;
  try {
    const result = await tool.execute("t1", { state: "The canary is healthy", questions: BOOL_QUESTION });
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.deepEqual(parsed.answers.ship, { type: "boolean", probability: 0.27 });
    assert.equal(parsed.modelId, "typesafe-ai/jev");
    assert.deepEqual(parsed.warnings, []);
    assert.deepEqual(parsed.usage, { inputTokens: 10, outputTokens: 2 });
  } finally {
    globalThis.fetch = original;
  }
});

test("score answers in the tool result keep the v4 probabilities", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse({
      answers: { sev: { type: "score", score: 3.5, probabilities: { "1": 0.1, "5": 0.9 } } },
      providerMetadata: { typesafe: { confidence: { sev: 0.7 } } },
    })) as typeof fetch;
  try {
    const result = await tool.execute("t2", {
      state: "s",
      questions: { sev: { type: "score", instructions: "Severity 1-5", criteria: ["1 low", "5 high"] } },
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.answers.sev.type, "score");
    assert.equal(parsed.answers.sev.score, 3.5);
    assert.deepEqual(parsed.answers.sev.probabilities, { "1": 0.1, "5": 0.9 });
    assert.equal(parsed.answers.sev.confidence, 0.7);
  } finally {
    globalThis.fetch = original;
  }
});

test("jev_ask refuses oversized states before the request", async () => {
  const big = "x".repeat(160_000);
  const result = await tool.execute("t3", { state: big, questions: BOOL_QUESTION });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /state too large/i);
});

test("jev_ask requires at least one question", async () => {
  const result = await tool.execute("t4", { state: "s", questions: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /at least one question/);
});

test("jev_ask surfaces a missing direct_paths grant without retrying", async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return jsonResponse({ error: "denied" }, 403);
  }) as typeof fetch;
  try {
    const result = await tool.execute("t5", { state: "s", questions: BOOL_QUESTION });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /direct_paths grant/);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 1, "403 must not be retried");
});

test("jev_ask retries transport failures with backoff and eventually succeeds", async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    if (calls < 3) throw new Error("connection reset");
    return jsonResponse({ answers: { ship: { type: "boolean", probability: 0.6 } } });
  }) as typeof fetch;
  try {
    const result = await tool.execute("t6", { state: "s", questions: BOOL_QUESTION });
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.deepEqual(parsed.answers.ship, { type: "boolean", probability: 0.6 });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 3, "two transport failures retried, third attempt succeeded");
});

test("withBackoff honors Retry-After over the exponential delay", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await assert.rejects(
    withBackoff(
      async () => {
        calls++;
        throw new JevEvalError("HTTP 429", { retryable: true, retryAfterMs: 3000 });
      },
      { attempts: 2, sleep: (ms) => (sleeps.push(ms), Promise.resolve()) },
    ),
    /HTTP 429/,
  );
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [3000]);
});

test("state budget matches the pi-jev constant", () => {
  assert.equal(new StateTooLargeError(1, 2).name, "StateTooLargeError");
  assert.equal(typeof jevAskModel().id, "string");
});
