import type { Api, Model } from "@earendil-works/pi-ai";

export const APERTURE_ORIGIN = "https://ai.corp.ts.net";
export const APERTURE_CATALOG_URL = `${APERTURE_ORIGIN}/v1/models`;

export const ROUTES = [
  {
    provider: "aperture-responses",
    name: "Aperture (Responses)",
    endpoint: "/v1/responses",
    api: "openai-responses" as const,
    baseUrl: `${APERTURE_ORIGIN}/v1`,
  },
  {
    provider: "aperture-completions",
    name: "Aperture (Chat Completions)",
    endpoint: "/v1/chat/completions",
    api: "openai-completions" as const,
    baseUrl: `${APERTURE_ORIGIN}/v1`,
  },
  {
    provider: "aperture-anthropic",
    name: "Aperture (Anthropic Messages)",
    endpoint: "/v1/messages",
    api: "anthropic-messages" as const,
    baseUrl: APERTURE_ORIGIN,
  },
] as const;

export type Route = (typeof ROUTES)[number];
export type ProviderModelConfig = Omit<Model<Api>, "provider">;

export interface ApertureCatalogModel {
  id: string;
  display_name?: string;
  supported_endpoints?: string[];
  context_window_tokens?: number;
  max_output_tokens?: number;
  pricing?: {
    input?: string | number;
    output?: string | number;
    input_cache_read?: string | number;
    input_cache_write?: string | number;
  };
  metadata?: {
    provider?: { id?: string };
  };
}

export interface ApertureCatalogPayload {
  data: ApertureCatalogModel[];
}

export interface ProjectedCatalog {
  byProvider: Map<string, ProviderModelConfig[]>;
  sourceCount: number;
  supportedCount: number;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function pricePerMillion(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? Number((parsed * 1_000_000).toPrecision(15)) : 0;
}

function normalizedId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function builtinCandidates(entry: ApertureCatalogModel, builtins: readonly Model<Api>[]): Model<Api>[] {
  const exact = builtins.filter((model) => model.id === entry.id);
  if (exact.length) return exact;

  const slash = entry.id.indexOf("/");
  if (slash > 0) {
    const prefix = entry.id.slice(0, slash);
    const unprefixed = entry.id.slice(slash + 1);
    const providerMatches = builtins.filter((model) => model.provider === prefix && model.id === unprefixed);
    if (providerMatches.length) return providerMatches;
    const idMatches = builtins.filter((model) => model.id === unprefixed);
    if (idMatches.length) return idMatches;
  }

  const normalized = normalizedId(entry.id);
  return builtins.filter((model) => normalizedId(model.id) === normalized);
}

function apiPreference(candidate: Model<Api>, route: Route): number {
  if (candidate.api === route.api) return 0;
  if (route.api === "openai-responses" && candidate.api === "openai-codex-responses") return 1;
  return 2;
}

function selectBuiltin(entry: ApertureCatalogModel, route: Route, builtins: readonly Model<Api>[]): Model<Api> | undefined {
  return builtinCandidates(entry, builtins).sort(
    (a, b) => apiPreference(a, route) - apiPreference(b, route) || a.provider.localeCompare(b.provider),
  )[0];
}

function inferReasoning(entry: ApertureCatalogModel): boolean {
  return /(?:^|[\/_-])(reasoning|thinking|o[134](?:-|$)|gpt-5|glm-4\.5|glm-5|deepseek-r1|qwen3)(?:[\/_-]|$)/i.test(
    entry.id,
  );
}

function inferImageInput(entry: ApertureCatalogModel): boolean {
  return /(vision|image|gemini|gpt-4o|gpt-5|claude|pixtral|vl(?:[\/_-]|$))/i.test(entry.id);
}

function projectModel(entry: ApertureCatalogModel, route: Route, builtins: readonly Model<Api>[]): ProviderModelConfig {
  const builtin = selectBuiltin(entry, route, builtins);
  const contextWindow = positiveInteger(entry.context_window_tokens, builtin?.contextWindow ?? 128_000);
  const maxTokens = Math.min(positiveInteger(entry.max_output_tokens, builtin?.maxTokens ?? 16_384), contextWindow);
  const pricing = entry.pricing;

  return {
    id: entry.id,
    name: entry.display_name?.trim() || builtin?.name || entry.id,
    api: route.api,
    baseUrl: route.baseUrl,
    reasoning: builtin?.reasoning ?? inferReasoning(entry),
    thinkingLevelMap: builtin?.thinkingLevelMap,
    input: builtin?.input ?? (inferImageInput(entry) ? ["text", "image"] : ["text"]),
    cost: pricing
      ? {
          input: pricePerMillion(pricing.input),
          output: pricePerMillion(pricing.output),
          cacheRead: pricePerMillion(pricing.input_cache_read),
          cacheWrite: pricePerMillion(pricing.input_cache_write),
        }
      : builtin?.cost ?? ZERO_COST,
    contextWindow,
    maxTokens,
    compat: builtin?.compat,
  };
}

export function parseCatalog(value: unknown): ApertureCatalogPayload {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) {
    throw new Error("Aperture returned an invalid model catalog");
  }

  const data = value.data.filter(
    (entry): entry is ApertureCatalogModel =>
      !!entry && typeof entry === "object" && "id" in entry && typeof entry.id === "string" && entry.id.length > 0,
  );
  if (!data.length) throw new Error("Aperture returned an empty model catalog");
  return { data };
}

export function projectCatalog(payload: ApertureCatalogPayload, builtins: readonly Model<Api>[]): ProjectedCatalog {
  const byProvider = new Map<string, ProviderModelConfig[]>(ROUTES.map((route) => [route.provider, []]));
  const assigned = new Set<string>();

  for (const route of ROUTES) {
    for (const entry of payload.data) {
      if (assigned.has(entry.id) || !entry.supported_endpoints?.includes(route.endpoint)) continue;
      byProvider.get(route.provider)!.push(projectModel(entry, route, builtins));
      assigned.add(entry.id);
    }
  }

  for (const models of byProvider.values()) models.sort((a, b) => a.id.localeCompare(b.id));
  return { byProvider, sourceCount: payload.data.length, supportedCount: assigned.size };
}

export async function fetchCatalog(signal?: AbortSignal): Promise<ApertureCatalogPayload> {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(APERTURE_CATALOG_URL, {
    headers: { accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`Aperture model catalog request failed: HTTP ${response.status}`);
  return parseCatalog(await response.json());
}
