import assert from "node:assert/strict";
import test from "node:test";
import { createApertureClassifier, JEV_MODEL_ID, JEV_PROVIDER_ID } from "../src/classifier.js";
import { jevClassifierModel } from "./helpers.js";

const model = jevClassifierModel();

function classifyContext(state: unknown, questions: Record<string, unknown>) {
  return { state: state as never, questions: questions as never };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("classifier maps v4 answers to pi classifier results", async () => {
  let captured: { url?: string; init?: RequestInit } = {};
  const classify = createApertureClassifier();
  const result = await classify(
    model,
    classifyContext(
      { pr: 42 },
      {
        risk: { type: "bool", instructions: "Deploy?", criteria: { true: "yes", false: "no" } },
        tone: { type: "choice", instructions: "Tone?", criteria: { calm: "", angry: "" } },
        sev: { type: "score", instructions: "Severity?", criteria: ["low", "high"] },
      },
    ),
    {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(input), init };
        return jsonResponse({
          answers: {
            risk: { type: "boolean", probability: 0.2 },
            tone: { type: "choice", choice: "calm", probabilities: { calm: 0.8, angry: 0.2 } },
            sev: { type: "score", score: 3.5, probabilities: { "1": 0.1, "5": 0.9 } },
          },
          usage: { inputTokens: 100, outputTokens: 5 },
          providerMetadata: { typesafe: { confidence: { tone: 0.9, sev: 0.7 } } },
        });
      }) as typeof fetch,
    },
  );

  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.answers.risk, { type: "bool", probability: 0.2 });
  assert.deepEqual(result.answers.tone, {
    type: "choice",
    choice: "calm",
    probabilities: { calm: 0.8, angry: 0.2 },
    confidence: 0.9,
  });
  assert.deepEqual(result.answers.sev, { type: "score", score: 3.5, confidence: 0.7 });
  assert.equal(result.usage?.input, 100);
  assert.equal(result.usage?.totalTokens, 105);

  // Wire contract: v4 spec, ZDR advertised, bool→boolean translation.
  assert.ok(captured.url?.endsWith("/direct/vercel-typesafe/v4/ai/evaluation-model"));
  const body = JSON.parse(String(captured.init?.body));
  assert.equal(body.questions.risk.type, "boolean");
  assert.equal(body.providerOptions.gateway.zeroDataRetention, true);
  assert.equal(body.state.pr, 42);
});

test("classifier normalizes 'boolean'-typed questions to the v4 wire type", async () => {
  let sent: Record<string, unknown> = {};
  const classify = createApertureClassifier();
  // Models following jev_ask's public shape send "boolean" instead of pi's
  // "bool"; the route must still receive "boolean" and answer a bool result.
  const result = await classify(
    model,
    classifyContext(
      { s: 1 },
      { q: { type: "boolean", instructions: "Go?", criteria: { true: "yes", false: "no" } } },
    ),
    {
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ answers: { q: { type: "boolean", probability: 0.75 } } });
      }) as typeof fetch,
    },
  );
  assert.equal((sent.questions as Record<string, unknown>).q && (sent.questions as Record<string, Record<string, unknown>>).q!.type, "boolean");
  assert.deepEqual(result.answers.q, { type: "bool", probability: 0.75 });
  assert.equal(result.stopReason, "stop");
});

test("classifier surfaces a missing direct_paths grant", async () => {
  const classify = createApertureClassifier();
  const result = await classify(
    model,
    classifyContext({}, { q: { type: "bool", instructions: "x", criteria: { true: "", false: "" } } }),
    { fetch: (async () => jsonResponse({ error: "denied" }, 403)) as typeof fetch },
  );
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /direct_paths grant/);
});

test("classifier errors keep stopReason error with a message, never throw", async () => {
  const classify = createApertureClassifier();
  const result = await classify(
    model,
    classifyContext({}, { q: { type: "bool", instructions: "x", criteria: { true: "", false: "" } } }),
    { fetch: (async () => jsonResponse({ answers: {} })) as typeof fetch },
  );
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /did not return an answer|no answers/);
});

test("classifier honors JEV_ORIGIN override and an explicitly resolved API key", async () => {
  process.env.JEV_ORIGIN = "https://aperture.example";
  try {
    let url: string | undefined;
    let auth: string | undefined;
    const classify = createApertureClassifier();
    // Models.applyAuth resolves the provider's auth (APERTURE_API_KEY or the
    // Tailscale marker) and passes it as options; the classifier consumes it.
    await classify(
      model,
      classifyContext({}, { q: { type: "bool", instructions: "x", criteria: { true: "", false: "" } } }),
      {
        apiKey: "secret",
        fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
          url = String(_input);
          auth = (init?.headers as Record<string, string>).authorization;
          return jsonResponse({ answers: { q: { type: "boolean", probability: 0.5 } } });
        }) as typeof fetch,
      },
    );
    assert.ok(url?.startsWith("https://aperture.example/direct/"));
    assert.equal(auth, "Bearer secret");
  } finally {
    delete process.env.JEV_ORIGIN;
  }
});

test("jev model identity is stable", () => {
  assert.equal(model.id, JEV_MODEL_ID);
  assert.equal(model.provider, JEV_PROVIDER_ID);
  assert.equal(model.api, "aperture-evaluation-v4");
  assert.equal(model.type, "classifier");
});
