import type { ClassifierFunction, ClassifierQuestion, ClassifierResult } from "@earendil-works/pi-ai";
import { APERTURE_ORIGIN } from "./catalog.js";

/**
 * Custom classifier API id for Jev through Aperture's direct provider access.
 * The built-in `typesafe-system-one` API speaks TypeSafe's v1 protocol
 * (`{baseUrl}/systemone`, `noul` answers, inline confidence); Aperture's
 * direct route speaks evaluation-model specification v4 (`boolean` answers,
 * confidence in `providerMetadata`), so it needs its own adapter.
 */
export const APERTURE_EVALUATION_API = "aperture-evaluation-v4";

export const JEV_MODEL_ID = "typesafe-ai/jev";
export const JEV_PROVIDER_ID = "typesafe-ai";

const DEFAULT_TIMEOUT_MS = 60_000;

/** v4 evaluation-model response. Confidence arrives out-of-band in providerMetadata. */
export interface V4Response {
  answers?: Record<string, Record<string, unknown>>;
  usage?: { inputTokens?: number; outputTokens?: number };
  warnings?: string[];
  providerMetadata?: {
    typesafe?: { confidence?: Record<string, number> };
    gateway?: { routing?: { originalModelId?: string }; cost?: string };
  };
}

/**
 * Evaluation error carrying retry semantics, mirroring the policy proven by
 * the pi-jev extension: transport failures and 429/529/5xx are retryable
 * (with Retry-After honored); everything else, including a missing
 * `direct_paths` grant, is not.
 */
export class JevEvalError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, options: { retryable: boolean; retryAfterMs?: number } = { retryable: false }) {
    super(message);
    this.name = "JevEvalError";
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function probabilities(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, probability]) => [key, numberOrZero(probability)]),
  );
}

/** A question body shaped like a bool question: `{true, false}` criteria. */
function isBoolShaped(body: Record<string, unknown>): boolean {
  const criteria = body.criteria;
  return (
    !!criteria &&
    typeof criteria === "object" &&
    !Array.isArray(criteria) &&
    "true" in (criteria as Record<string, unknown>) &&
    "false" in (criteria as Record<string, unknown>)
  );
}

/** Normalized evaluation result in the vocabulary both surfaces share. */
export interface JevEvalResult {
  answers: Record<string, Record<string, unknown>>;
  usage?: { inputTokens: number; outputTokens: number };
  warnings: string[];
  modelId: string;
  cost?: string;
}

export interface JevEvalOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Resolved credential: an API key is sent as a bearer token; without one
   *  the non-secret Tailscale identity marker is used (Aperture authenticates
   *  the connection by Tailscale identity and ignores the marker value). */
  apiKey?: string;
}

/**
 * Run one Jev evaluation through Aperture direct provider access
 * (evaluation-model specification v4). Throws {@link JevEvalError} on
 * failure; answers use the v4 vocabulary (`boolean`/`choice`/`score`) with
 * confidence resolved from `providerMetadata.typesafe.confidence`.
 *
 * Mirrors the wire contract proven by the pi-jev extension: requests always
 * advertise `providerOptions.gateway.zeroDataRetention: true` (ZDR is the
 * route's policy, not a per-request choice), and the JEV_ORIGIN /
 * JEV_PROVIDER / JEV_MODEL_ID environment variables override the route.
 */
export async function jevEvaluate(
  model: { id: string },
  context: { state: unknown; questions: Record<string, unknown> },
  options: JevEvalOptions = {},
): Promise<JevEvalResult> {
  const origin = (process.env.JEV_ORIGIN?.trim() || APERTURE_ORIGIN).replace(/\/+$/, "");
  const provider = process.env.JEV_PROVIDER?.trim() || "vercel-typesafe";
  const modelId = process.env.JEV_MODEL_ID?.trim() || model.id;
  const url = `${origin}/direct/${provider}/v4/ai/evaluation-model`;
  const requestFetch = options.fetch ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    "ai-gateway-protocol-version": "0.0.1",
    "ai-gateway-auth-method": "api-key",
    "ai-evaluation-model-specification-version": "4",
    "ai-model-id": modelId,
  };
  if (!options.apiKey) {
    // Non-secret identity marker; Aperture authenticates by Tailscale identity.
    headers.authorization = "Tailscale";
  }

  // v4 speaks "boolean"; pi's classifier questions use "bool". Callers coming
  // through the jev_ask habit (or ad-hoc scripts) sometimes send "boolean";
  // normalize any bool-shaped question to the wire type rather than letting it
  // fall through to score.
  const wireTypes = new Map<string, "boolean" | "choice" | "score">();
  const questions = Object.fromEntries(
    Object.entries(context.questions).map(([id, question]) => {
      const { type, ...rest } = question as { type: string } & Record<string, unknown>;
      // pi's classifier union uses "bool"; callers arriving through the
      // jev_ask habit (or ad-hoc scripts) sometimes send "boolean". Treat
      // both as the v4 wire type, infer from shape on anything unknown.
      const wire: "boolean" | "choice" | "score" =
        type === "bool" || type === "boolean"
          ? "boolean"
          : type === "choice"
            ? "choice"
            : type === "score"
              ? "score"
              : isBoolShaped(rest)
                ? "boolean"
                : "score";
      wireTypes.set(id, wire);
      return [id, { ...rest, type: wire }];
    }),
  );
  const body = {
    state: context.state,
    questions,
    providerOptions: { gateway: { zeroDataRetention: true } },
  };

  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await requestFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Timeouts and connection failures are retriable; the call itself did not
    // reach a verdict.
    throw new JevEvalError(`Aperture evaluation route transport failure: ${error instanceof Error ? error.message : String(error)}`, {
      retryable: true,
    });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 403) {
      throw new JevEvalError(
        "Aperture evaluation route returned HTTP 403 — no direct_paths grant matches this identity and path; " +
          "an Aperture admin must add a matching grant",
      );
    }
    if (response.status === 501) {
      throw new JevEvalError(
        "Aperture evaluation route returned HTTP 501 — the direct_access_api flag is disabled on this Aperture instance",
      );
    }
    const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter ? numberOrZero(Number(retryAfter) * 1000) : undefined;
    throw new JevEvalError(
      `Aperture evaluation route returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      { retryable, retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs! > 0 ? retryAfterMs : undefined },
    );
  }
  let payload: V4Response;
  try {
    payload = (await response.json()) as V4Response;
  } catch (error) {
    throw new JevEvalError(`Aperture evaluation route returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!payload.answers || typeof payload.answers !== "object") {
    throw new JevEvalError("Aperture evaluation route returned no answers");
  }
  const confidence = payload.providerMetadata?.typesafe?.confidence ?? {};
  const answers: Record<string, Record<string, unknown>> = {};
  for (const [id, wire] of wireTypes) {
    const answer = payload.answers[id];
    if (!answer) throw new JevEvalError(`Aperture evaluation route did not return an answer for ${id}`);
    if (wire === "boolean") {
      if (answer.type !== "boolean" || typeof answer.probability !== "number") {
        throw new JevEvalError(`Aperture evaluation route returned an invalid bool answer for ${id}`);
      }
      answers[id] = { type: "boolean", probability: answer.probability };
    } else if (wire === "choice") {
      if (answer.type !== "choice" || typeof answer.choice !== "string") {
        throw new JevEvalError(`Aperture evaluation route returned an invalid choice answer for ${id}`);
      }
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        probabilities: probabilities(answer.probabilities),
        confidence: numberOrZero(confidence[id]),
      };
    } else {
      if (answer.type !== "score" || typeof answer.score !== "number") {
        throw new JevEvalError(`Aperture evaluation route returned an invalid score answer for ${id}`);
      }
      answers[id] = {
        type: "score",
        score: numberOrZero(answer.score),
        probabilities: probabilities(answer.probabilities),
        confidence: numberOrZero(confidence[id]),
      };
    }
  }
  const usageIn = numberOrZero(payload.usage?.inputTokens);
  const usageOut = numberOrZero(payload.usage?.outputTokens);
  return {
    answers,
    ...(usageIn || usageOut ? { usage: { inputTokens: usageIn, outputTokens: usageOut } } : {}),
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
    modelId: payload.providerMetadata?.gateway?.routing?.originalModelId ?? modelId,
    ...(payload.providerMetadata?.gateway?.cost ? { cost: payload.providerMetadata.gateway.cost } : {}),
  };
}

/**
 * pi-ai classifier adapter over {@link jevEvaluate}: maps the v4 vocabulary to
 * the `ClassifierResult` contract (never throws; errors become `stopReason:
 * "error"` results). pi's classifier answer type has no score probabilities,
 * so score answers narrow to score + confidence here.
 */
export function createApertureClassifier(): ClassifierFunction {
  return async (model, context, options) => {
    const result: ClassifierResult = {
      api: model.api,
      provider: model.provider,
      model: model.id,
      answers: {},
      stopReason: "stop",
      timestamp: Date.now(),
    };
    try {
      const evaluated = await jevEvaluate(
        model,
        { state: context.state, questions: context.questions as Record<string, unknown> },
        {
          signal: options?.signal,
          ...(options?.fetch ? { fetch: options.fetch } : {}),
          ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
        },
      );
      const answers: ClassifierResult["answers"] = {};
      for (const [id, raw] of Object.entries(evaluated.answers)) {
        const answer = raw as {
          type: string;
          probability?: number;
          choice?: string;
          score?: number;
          probabilities?: Record<string, number>;
          confidence?: number;
        };
        if (answer.type === "boolean") {
          answers[id] = { type: "bool", probability: answer.probability ?? 0 };
        } else if (answer.type === "choice") {
          answers[id] = {
            type: "choice",
            choice: answer.choice ?? "",
            probabilities: answer.probabilities ?? {},
            confidence: answer.confidence ?? 0,
          };
        } else {
          answers[id] = { type: "score", score: answer.score ?? 0, confidence: answer.confidence ?? 0 };
        }
      }
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        answers,
        ...(evaluated.usage
          ? {
              usage: {
                input: evaluated.usage.inputTokens,
                output: evaluated.usage.outputTokens,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: evaluated.usage.inputTokens + evaluated.usage.outputTokens,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            }
          : {}),
        stopReason: "stop",
        timestamp: Date.now(),
      };
    } catch (error) {
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        answers: {},
        stopReason: options?.signal?.aborted ? "aborted" : "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
    }
  };
}
