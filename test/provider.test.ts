import assert from "node:assert/strict";
import test from "node:test";
import type { ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { parseCatalog, projectCatalog, ROUTES, type ProviderModelConfig } from "../src/catalog.js";
import { createApertureProvider } from "../src/index.js";

function model(id: string): ProviderModelConfig {
  return {
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "https://ai.corp.ts.net/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function refreshContext(options: {
  allowNetwork: boolean;
  stored?: ModelsStoreEntry;
}): RefreshModelsContext {
  return {
    allowNetwork: options.allowNetwork,
    stored: options.stored,
    signal: new AbortController().signal,
    async publish(publication) {
      publication.update?.();
      return true;
    },
  };
}

test("provider refresh fully replaces the catalog and removes stale models", async () => {
  const route = ROUTES[0];
  const provider = createApertureProvider(route, [model("removed"), model("retained")], async () => [
    model("retained"),
    model("added"),
  ]);

  assert.deepEqual(provider.getModels().map((entry) => entry.id), ["removed", "retained"]);
  await provider.refreshModels!(refreshContext({ allowNetwork: true }));
  assert.deepEqual(provider.getModels().map((entry) => entry.id), ["retained", "added"]);
});

test("endpoint migration removes a model from the old provider and adds it to the new one", async () => {
  const catalog = (endpoint: string) =>
    projectCatalog(parseCatalog({ data: [{ id: "migrating", supported_endpoints: [endpoint] }] }), []);
  let projected = catalog("/v1/responses");
  const responses = createApertureProvider(
    ROUTES[0],
    projected.byProvider.get(ROUTES[0].provider) ?? [],
    async () => projected.byProvider.get(ROUTES[0].provider) ?? [],
  );
  const anthropic = createApertureProvider(
    ROUTES[2],
    projected.byProvider.get(ROUTES[2].provider) ?? [],
    async () => projected.byProvider.get(ROUTES[2].provider) ?? [],
  );

  assert.deepEqual(responses.getModels().map((entry) => entry.id), ["migrating"]);
  assert.deepEqual(anthropic.getModels().map((entry) => entry.id), []);

  projected = catalog("/v1/messages");
  await responses.refreshModels!(refreshContext({ allowNetwork: true }));
  await anthropic.refreshModels!(refreshContext({ allowNetwork: true }));

  assert.deepEqual(responses.getModels().map((entry) => entry.id), []);
  assert.deepEqual(anthropic.getModels().map((entry) => entry.id), ["migrating"]);
});

test("offline refresh restores the persisted catalog without fetching", async () => {
  const route = ROUTES[0];
  let fetches = 0;
  const provider = createApertureProvider(route, [model("startup")], async () => {
    fetches++;
    return [model("network")];
  });
  const storedModel = { ...model("stored"), provider: route.provider };

  await provider.refreshModels!(
    refreshContext({
      allowNetwork: false,
      stored: { models: [storedModel], checkedAt: Date.now() },
    }),
  );

  assert.equal(fetches, 0);
  assert.deepEqual(provider.getModels().map((entry) => entry.id), ["stored"]);
});

test("ambient authentication uses a non-secret marker and explicit key wins", async () => {
  const provider = createApertureProvider(ROUTES[0], [model("one")], async () => []);
  const resolver = provider.auth.apiKey!.resolve;
  const signal = new AbortController().signal;
  const ambient = await resolver({ ctx: { env: async () => undefined, fileExists: async () => false }, signal });
  assert.deepEqual(ambient?.auth, { headers: { authorization: "Tailscale" } });

  const keyed = await resolver({
    ctx: { env: async (name) => (name === "APERTURE_API_KEY" ? "secret" : undefined), fileExists: async () => false },
    signal,
  });
  assert.deepEqual(keyed?.auth, { apiKey: "secret" });
});
