import assert from "node:assert/strict";
import test from "node:test";
import type { ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { parseCatalog, projectCatalog, type ProjectedProvider, type ProviderModelConfig } from "../src/catalog.js";
import { createApertureProvider } from "../src/index.js";

function model(id: string, api: ProviderModelConfig["api"] = "openai-responses"): ProviderModelConfig {
  return {
    id,
    name: id,
    api,
    baseUrl: api === "anthropic-messages" ? "https://ai.corp.ts.net" : "https://ai.corp.ts.net/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function backing(id: string, models: ProviderModelConfig[]): ProjectedProvider {
  return { id, name: id, models };
}

function refreshContext(options: { allowNetwork: boolean; stored?: ModelsStoreEntry }): RefreshModelsContext {
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

test("provider refresh fully replaces the backing route catalog", async () => {
  const provider = createApertureProvider(backing("vercel-ent", [model("removed"), model("retained")]), async () => [
    model("retained"),
    model("added"),
  ]);

  assert.deepEqual(provider.getModels().map((entry) => entry.id), ["removed", "retained"]);
  await provider.refreshModels!(refreshContext({ allowNetwork: true }));
  assert.deepEqual(provider.getModels().map((entry) => entry.id), ["retained", "added"]);
});

test("backing-route migration removes a model from the old route and adds it to the new route", async () => {
  const catalog = (provider: string) =>
    projectCatalog(
      parseCatalog({
        data: [{ id: "migrating", supported_endpoints: ["/v1/responses"], metadata: { provider: { id: provider } } }],
      }),
      [],
    );
  let projected = catalog("vercel-ent");
  const vercel = createApertureProvider(
    projected.providers.get("vercel-ent")!,
    async () => projected.providers.get("vercel-ent")?.models ?? [],
  );
  const openrouter = createApertureProvider(
    backing("openrouter", []),
    async () => projected.providers.get("openrouter")?.models ?? [],
  );

  projected = catalog("openrouter");
  await vercel.refreshModels!(refreshContext({ allowNetwork: true }));
  await openrouter.refreshModels!(refreshContext({ allowNetwork: true }));

  assert.deepEqual(vercel.getModels().map((entry) => entry.id), []);
  assert.deepEqual(openrouter.getModels().map((entry) => entry.id), ["migrating"]);
});

test("one backing provider can dispatch models through different APIs", () => {
  const provider = createApertureProvider(
    backing("vercel-ent", [model("responses"), model("messages", "anthropic-messages")]),
    async () => [],
  );
  assert.deepEqual(provider.getModels().map((entry) => entry.api), ["openai-responses", "anthropic-messages"]);
});

test("offline refresh restores the persisted backing-route catalog without fetching", async () => {
  let fetches = 0;
  const provider = createApertureProvider(backing("vercel-ent", [model("startup")]), async () => {
    fetches++;
    return [model("network")];
  });
  const storedModel = { ...model("stored"), provider: "vercel-ent" };

  await provider.refreshModels!(
    refreshContext({ allowNetwork: false, stored: { models: [storedModel], checkedAt: Date.now() } }),
  );

  assert.equal(fetches, 0);
  assert.deepEqual(provider.getModels().map((entry) => entry.id), ["stored"]);
});

test("offline refresh ignores a colliding built-in provider cache", async () => {
  const provider = createApertureProvider(backing("anthropic", [model("aperture-startup", "anthropic-messages")]), async () => []);
  const directModel = {
    ...model("direct-anthropic", "anthropic-messages"),
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
  };

  await provider.refreshModels!(
    refreshContext({ allowNetwork: false, stored: { models: [directModel], checkedAt: Date.now() } }),
  );

  assert.deepEqual(provider.getModels().map((entry) => entry.id), ["aperture-startup"]);
});

test("ambient authentication uses a non-secret marker and explicit key wins", async () => {
  const provider = createApertureProvider(backing("vercel-ent", [model("one")]), async () => []);
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
