import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  Api,
  AuthContext,
  Model,
  Provider,
  ProviderStreams,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages";
import * as openAICompletions from "@earendil-works/pi-ai/api/openai-completions";
import * as openAIResponses from "@earendil-works/pi-ai/api/openai-responses";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
): Provider {
  let models = routeModels(backing.id, backing.models);
  const streams: Partial<Record<Api, ProviderStreams>> = {
    "openai-responses": openAIResponses,
    "openai-completions": openAICompletions,
    "anthropic-messages": anthropicMessages,
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
    async refreshModels(context: RefreshModelsContext) {
      if (context.stored) {
        const providerModels = context.stored.models.filter((model) => model.provider === backing.id);
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
  const builtins = getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider));
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
}
