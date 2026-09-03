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
  fetchCatalog,
  parseCatalog,
  projectCatalog,
  ROUTES,
  type ApertureCatalogPayload,
  type ProjectedCatalog,
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

function routeApi(api: Api): ProviderStreams {
  switch (api) {
    case "openai-responses":
      return openAIResponses;
    case "openai-completions":
      return openAICompletions;
    case "anthropic-messages":
      return anthropicMessages;
    default:
      throw new Error(`Unsupported Aperture API: ${api}`);
  }
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
  route: (typeof ROUTES)[number],
  initial: ProviderModelConfig[],
  refresh: (signal: AbortSignal) => Promise<ProviderModelConfig[]>,
): Provider {
  let models = routeModels(route.provider, initial);
  const streams = routeApi(route.api);

  return {
    id: route.provider,
    name: route.name,
    baseUrl: route.baseUrl,
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
        const restored = context.stored.models.filter((model) => model.provider === route.provider);
        if (!(await context.publish({ update: () => { models = restored; } }))) return;
      }
      if (!context.allowNetwork || context.signal.aborted) return;
      const refreshed = routeModels(route.provider, await refresh(context.signal));
      if (context.signal.aborted) return;
      await context.publish({
        persist: { models: refreshed, checkedAt: Date.now() },
        update: () => { models = refreshed; },
      });
    },
    stream: (model, context, options) => streams.stream(model, context, options),
    streamSimple: (model, context, options) => streams.streamSimple(model, context, options),
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

  for (const route of ROUTES) {
    const initial = current.byProvider.get(route.provider) ?? [];
    pi.registerProvider(
      createApertureProvider(route, initial, async (signal) => {
        const refreshed = await fetchProjected(signal);
        return refreshed.byProvider.get(route.provider) ?? [];
      }),
    );
  }
}
