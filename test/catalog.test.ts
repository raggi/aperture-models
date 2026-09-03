import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseCatalog, projectCatalog, ROUTES } from "../src/catalog.js";

const builtin: Model<Api> = {
  id: "gpt-test",
  name: "Built-in GPT Test",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
  contextWindow: 10,
  maxTokens: 5,
  compat: { supportsReasoningEffort: true },
};

test("parseCatalog rejects malformed and empty catalogs", () => {
  assert.throws(() => parseCatalog({}), /invalid model catalog/);
  assert.throws(() => parseCatalog({ data: [] }), /empty model catalog/);
});

test("projection deduplicates IDs using endpoint precedence", () => {
  const projected = projectCatalog(
    parseCatalog({
      data: [
        {
          id: "gpt-test",
          display_name: "Gateway GPT Test",
          supported_endpoints: ["/v1/messages", "/v1/responses", "/v1/chat/completions"],
          context_window_tokens: 200_000,
          max_output_tokens: 20_000,
          pricing: { input: "0.000001", output: "0.000002", input_cache_read: "0.0000001" },
        },
        { id: "chat-only", supported_endpoints: ["/v1/chat/completions"] },
        { id: "messages-only", supported_endpoints: ["/v1/messages"] },
        { id: "embedding", supported_endpoints: ["/v1/embeddings"] },
      ],
    }),
    [builtin],
  );

  assert.equal(projected.sourceCount, 4);
  assert.equal(projected.supportedCount, 3);
  assert.deepEqual(projected.byProvider.get("aperture-responses")?.map((model) => model.id), ["gpt-test"]);
  assert.deepEqual(projected.byProvider.get("aperture-completions")?.map((model) => model.id), ["chat-only"]);
  assert.deepEqual(projected.byProvider.get("aperture-anthropic")?.map((model) => model.id), ["messages-only"]);

  const model = projected.byProvider.get("aperture-responses")![0];
  assert.equal(model.api, "openai-responses");
  assert.equal(model.name, "Gateway GPT Test");
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.maxTokens, 20_000);
  assert.deepEqual(model.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 });
  assert.deepEqual(model.compat, builtin.compat);
});

test("all configured route providers have distinct endpoint and API mappings", () => {
  assert.equal(new Set(ROUTES.map((route) => route.provider)).size, ROUTES.length);
  assert.equal(new Set(ROUTES.map((route) => route.endpoint)).size, ROUTES.length);
  assert.equal(new Set(ROUTES.map((route) => route.api)).size, ROUTES.length);
});

test("optional Aperture fixture projects expected aliases", { skip: !process.env.APERTURE_FIXTURE }, async () => {
  const raw = JSON.parse(await readFile(process.env.APERTURE_FIXTURE!, "utf8"));
  const projected = projectCatalog(parseCatalog(raw), []);
  const responses = new Set(projected.byProvider.get("aperture-responses")?.map((model) => model.id));
  assert(responses.has("zai/glm-5.2"));
  assert(responses.has("google/gemini-3.7-flash"));
  assert(responses.has("openai/gpt-5.6-sol"));
  assert(responses.has("gpt-5.6-sol"));
});
