import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseCatalog, projectCatalog, PROTOCOLS } from "../src/catalog.js";

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

const backing = (id: string, name = id) => ({ provider: { id, name } });

test("parseCatalog rejects malformed and empty catalogs", () => {
  assert.throws(() => parseCatalog({}), /invalid model catalog/);
  assert.throws(() => parseCatalog({ data: [] }), /empty model catalog/);
});

test("projection groups by backing route and selects protocol per model", () => {
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
          metadata: backing("vercel-ent", "Vercel"),
        },
        {
          id: "chat-only",
          supported_endpoints: ["/v1/chat/completions"],
          metadata: backing("vercel-ent", "Vercel"),
        },
        { id: "messages-only", supported_endpoints: ["/v1/messages"], metadata: backing("anthropic", "Anthropic") },
        { id: "embedding", supported_endpoints: ["/v1/embeddings"], metadata: backing("other") },
      ],
    }),
    [builtin],
  );

  assert.equal(projected.sourceCount, 4);
  assert.equal(projected.supportedCount, 3);
  assert.deepEqual([...projected.providers.keys()], ["vercel-ent", "anthropic"]);
  assert.deepEqual(projected.providers.get("vercel-ent")?.models.map((model) => [model.id, model.api]), [
    ["chat-only", "openai-completions"],
    ["gpt-test", "openai-responses"],
  ]);
  assert.deepEqual(projected.providers.get("anthropic")?.models.map((model) => [model.id, model.api]), [
    ["messages-only", "anthropic-messages"],
  ]);

  const model = projected.providers.get("vercel-ent")!.models.find((entry) => entry.id === "gpt-test")!;
  assert.equal(model.name, "Gateway GPT Test");
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.maxTokens, 20_000);
  assert.deepEqual(model.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 });
  assert.deepEqual(model.compat, builtin.compat);
});

test("evaluation models are excluded from chat providers", () => {
  const projected = projectCatalog(
    parseCatalog({
      data: [
        {
          id: "typesafe-ai/jev",
          display_name: "Jev",
          supported_endpoints: ["/v1/messages", "/v1/responses", "/v1/chat/completions"],
          context_window_tokens: 128_000,
          metadata: backing("typesafe-ai", "TypeSafe AI"),
        },
      ],
    }),
    [builtin],
  );

  assert.equal(projected.providers.size, 0);
  assert.equal(projected.supportedCount, 0);
  assert.deepEqual(projected.evaluationModels.map((entry) => entry.id), ["typesafe-ai/jev"]);
});

test("duplicate model IDs are preserved across backing routes", () => {
  const projected = projectCatalog(
    parseCatalog({
      data: [
        { id: "same", supported_endpoints: ["/v1/responses"], metadata: backing("vercel-ent") },
        { id: "same", supported_endpoints: ["/v1/chat/completions"], metadata: backing("openrouter") },
      ],
    }),
    [],
  );
  assert.equal(projected.supportedCount, 2);
  assert.equal(projected.providers.get("vercel-ent")?.models[0]?.id, "same");
  assert.equal(projected.providers.get("openrouter")?.models[0]?.id, "same");
});

test("protocol precedence is unique", () => {
  assert.equal(new Set(PROTOCOLS.map((route) => route.endpoint)).size, PROTOCOLS.length);
  assert.equal(new Set(PROTOCOLS.map((route) => route.api)).size, PROTOCOLS.length);
});

test("optional Aperture fixture projects expected backing routes", { skip: !process.env.APERTURE_FIXTURE }, async () => {
  const raw = JSON.parse(await readFile(process.env.APERTURE_FIXTURE!, "utf8"));
  const projected = projectCatalog(parseCatalog(raw), []);
  assert(projected.supportedCount > 0, "fixture projects at least one model");
  // The live route set changes over time (e.g. vercel-ent → vercel-ent-zdr);
  // assert the projected routes carry the catalog's expected model families
  // rather than pinning route names.
  const families = ["zai/glm-5.2", "google/gemini-3.7-flash", "openai/gpt-5.6-sol"];
  const allModels = [...projected.providers.values()].flatMap((provider) => provider.models.map((model) => model.id));
  for (const family of families) {
    assert(allModels.includes(family), `fixture projects ${family}`);
  }
});
