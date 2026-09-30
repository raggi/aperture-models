import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  Api,
  AuthContext,
  ClassifierFunction,
  ClassifierModel,
  ClassifierApi,
  Model,
  Provider,
  ProviderStreams,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
// pi-ai subpath imports are only safe where the host resolves them natively:
// extension loaders that run extensions through jiti's alias map (SDK/runner
// child sessions) prefix-replace the package specifier, so unaliased subpaths
// like /api/* or /utils/* mangle into broken module paths there. The root and
// the /compat and /providers/all subpaths are aliased (or natively resolvable)
// in every host context, and the compat entry re-exports the API adapters.
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi, isModelType } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  APERTURE_EVALUATION_API,
  createApertureClassifier,
  JEV_MODEL_ID,
  JEV_PROVIDER_ID,
} from "./classifier.js";
import { createJevAskTool } from "./jev-tool.js";
import { reconcileApertureStore } from "./store-reconcile.js";
import {
  APERTURE_ORIGIN,
  fetchCatalog,
  parseCatalog,
  projectCatalog,
  type ApertureCatalogPayload,
  type ProjectedCatalog,
  type ProjectedProvider,
  type ProviderModelConfig,
} from "./catalog.js";

const CACHE_FILE = join(
  process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"),
  "pi-aperture-models",
  "catalog.json",
);
const FETCH_COALESCE_MS = 2_000;

interface CacheDocument {
  version: 1;
  fetchedAt: string;
  catalog: ApertureCatalogPayload;
}

async function readCache(): Promise<ApertureCatalogPayload | undefined> {
  try {
    const document = JSON.parse(await readFile(CACHE_FILE, "utf8")) as Partial<CacheDocument>;
    if (document.version !== 1) return undefined;
    return parseCatalog(document.catalog);
  } catch {
    return undefined;
  }
}

async function writeCache(catalog: ApertureCatalogPayload): Promise<void> {
  const temporary = `${CACHE_FILE}.${process.pid}.tmp`;
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(
    temporary,
    `${JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), catalog } satisfies CacheDocument, null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, CACHE_FILE);
}

function routeModels(provider: string, models: ProviderModelConfig[]): Model<Api>[] {
  return models.map((model) => ({ ...model, provider }));
}

/** The Jev classifier rides Aperture's direct evaluation route (spec v4). */
function jevClassifierModel(): ClassifierModel<ClassifierApi> {
  return {
    id: JEV_MODEL_ID,
    name: "Jev",
    type: "classifier",
    api: APERTURE_EVALUATION_API,
    input: ["text"],
    baseUrl: APERTURE_ORIGIN,
    provider: JEV_PROVIDER_ID,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
  };
}

async function resolveAuth(ctx: AuthContext) {
  const apiKey = (await ctx.env("APERTURE_API_KEY"))?.trim();
  return {
    // Aperture authenticates the connection using Tailscale identity. This
    // non-secret marker satisfies client SDK auth guards and is ignored by
    // Aperture. An explicit key retains protocol-specific SDK handling.
    auth: apiKey ? { apiKey } : { headers: { authorization: "Tailscale" } },
    source: apiKey ? "APERTURE_API_KEY" : "Tailscale identity",
  };
}

export function createApertureProvider(
  backing: ProjectedProvider,
  refresh: (signal: AbortSignal) => Promise<ProviderModelConfig[]>,
  options: { classifier?: ClassifierFunction } = {},
): Provider {
  let models = routeModels(backing.id, backing.models);
  const streams: Partial<Record<Api, ProviderStreams>> = {
    "openai-responses": openAIResponsesApi(),
    "openai-completions": openAICompletionsApi(),
    "anthropic-messages": anthropicMessagesApi(),
  };
  const streamFor = (api: Api): ProviderStreams => {
    const implementation = streams[api];
    if (!implementation) throw new Error(`Unsupported Aperture API: ${api}`);
    return implementation;
  };

  return {
    id: backing.id,
    name: backing.name,
    baseUrl: APERTURE_ORIGIN,
    auth: {
      apiKey: {
        name: "Tailscale identity",
        async check() {
          return { type: "api_key", source: "Tailscale identity" };
        },
        async resolve({ ctx }) {
          return resolveAuth(ctx);
        },
      },
    },
    getModels: () => models,
    getAllModels: options.classifier
      ? () => [...models, jevClassifierModel()]
      : undefined,
    classify: options.classifier
      ? (model, context, classifyOptions) => options.classifier!(model, context, classifyOptions)
      : undefined,
    async refreshModels(context: RefreshModelsContext) {
      if (context.stored) {
        // pi 0.99 stores can hold image/classifier entries too; restore only
        // chat models into this chat-protocol provider.
        const providerModels = context.stored.models.filter(
          (model): model is Model<Api> => model.provider === backing.id && isModelType(model, "chat"),
        );
        const restored = providerModels.filter((model) => model.baseUrl?.startsWith(APERTURE_ORIGIN));
        // Built-in providers can have used the same store key before this
        // extension overrode them. Restore only catalogs wholly owned by
        // Aperture; otherwise retain the freshly fetched startup projection.
        if (providerModels.length === restored.length) {
          if (!(await context.publish({ update: () => { models = restored; } }))) return;
        }
      }
      if (!context.allowNetwork || context.signal.aborted) return;
      const refreshed = routeModels(backing.id, await refresh(context.signal));
      if (context.signal.aborted) return;
      await context.publish({
        persist: { models: refreshed, checkedAt: Date.now() },
        update: () => { models = refreshed; },
      });
    },
    stream: (model, context, options) => streamFor(model.api).stream(model, context, options),
    streamSimple: (model, context, options) => streamFor(model.api).streamSimple(model, context, options),
  };
}

export default async function apertureModels(pi: ExtensionAPI): Promise<void> {
  // pi 0.99 model lists mix chat, image, and classifier entries; only chat
  // models can provide wire-protocol matches for Aperture routes.
  const builtins = getBuiltinProviders()
    .flatMap((provider) => getBuiltinModels(provider))
    .filter((model) => isModelType(model, "chat"));
  let current: ProjectedCatalog;
  let latestFetch: { startedAt: number; promise: Promise<ProjectedCatalog> } | undefined;

  const fetchProjected = (signal?: AbortSignal): Promise<ProjectedCatalog> => {
    const now = Date.now();
    if (latestFetch && now - latestFetch.startedAt < FETCH_COALESCE_MS) return latestFetch.promise;

    const promise = fetchCatalog(signal).then(async (catalog) => {
      const projected = projectCatalog(catalog, builtins);
      current = projected;
      await writeCache(catalog).catch(() => undefined);
      return projected;
    });
    latestFetch = { startedAt: now, promise };
    return promise;
  };

  try {
    current = await fetchProjected();
  } catch (networkError) {
    const cached = await readCache();
    if (!cached) {
      const detail = networkError instanceof Error ? networkError.message : String(networkError);
      throw new Error(`Could not load Aperture models and no cache is available: ${detail}`);
    }
    current = projectCatalog(cached, builtins);
  }

  for (const backing of current.providers.values()) {
    pi.registerProvider(
      createApertureProvider(backing, async (signal) => {
        const refreshed = await fetchProjected(signal);
        return refreshed.providers.get(backing.id)?.models ?? [];
      }),
    );
  }

  // Jev has no chat wire API; register it as a classifier provider so codemode
  // scripts can call `models.classify()` with the session's ambient credentials.
  // `stream`/`streamSimple` throw per the Provider contract: this provider has
  // no chat models, so a chat request to it is always a programming error.
  const jevProvider: Provider = {
    id: JEV_PROVIDER_ID,
    name: "TypeSafe AI (Aperture direct)",
    baseUrl: APERTURE_ORIGIN,
    auth: {
      apiKey: {
        name: "Tailscale identity",
        async check() {
          return { type: "api_key", source: "Tailscale identity" };
        },
        async resolve({ ctx }) {
          return resolveAuth(ctx);
        },
      },
    },
    getModels: () => [],
    getAllModels: () => [jevClassifierModel()],
    stream: () => {
      throw new Error("typesafe-ai is a classifier-only provider; Jev has no chat wire API");
    },
    streamSimple: () => {
      throw new Error("typesafe-ai is a classifier-only provider; Jev has no chat wire API");
    },
    classify: createApertureClassifier(),
  };
  pi.registerProvider(jevProvider);

  // The jev_ask judgment tool for chat models (codemode scripts use
  // models.classify() on the classifier provider above). Ambient key from the
  // environment mirrors the provider auth resolution.
  pi.registerTool(createJevAskTool({ apiKey: process.env.APERTURE_API_KEY?.trim() || undefined }));

  // Keep the persisted model store tidy when Aperture's route set changes:
  // entries for backing routes the catalog no longer projects are stale caches.
  void reconcileApertureStore(new Set(current.providers.keys())).then(
    ({ removed }) => {
      if (removed.length) console.error(`[aperture-models] pruned stale model store entries: ${removed.join(", ")}`);
    },
  );
}
