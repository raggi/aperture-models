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
interface V4Response {
  answers?: Record<string, Record<string, unknown>>;
  usage?: { inputTokens?: number; outputTokens?: number };
  providerMetadata?: {
    typesafe?: { confidence?: Record<string, number> };
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

function probabilities(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, probability]) => [key, numberOrZero(probability)]),
  );
}

/**
 * Runs one Jev classification through Aperture direct provider access
 * (evaluation-model specification v4, Tailscale identity or APERTURE_API_KEY).
 *
 * Mirrors the wire contract proven by the pi-jev extension: requests always
 * advertise `providerOptions.gateway.zeroDataRetention: true` (ZDR is the
 * route's policy, not a per-request choice), and confidence for choice/score
 * answers arrives in `providerMetadata.typesafe.confidence`.
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
      const origin = (process.env.JEV_ORIGIN?.trim() || APERTURE_ORIGIN).replace(/\/+$/, "");
      const provider = process.env.JEV_PROVIDER?.trim() || "vercel-typesafe";
      const modelId = process.env.JEV_MODEL_ID?.trim() || model.id;
      const url = `${origin}/direct/${provider}/v4/ai/evaluation-model`;
      const requestFetch = options?.fetch ?? fetch;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        // Non-secret identity marker; Aperture authenticates by Tailscale
        // identity. An explicit API key retains normal bearer handling.
        ...(options?.headers ?? {}),
        authorization: options?.apiKey ? `Bearer ${options.apiKey}` : (options?.headers?.authorization ?? "Tailscale"),
        "ai-gateway-protocol-version": "0.0.1",
        "ai-gateway-auth-method": "api-key",
        "ai-evaluation-model-specification-version": "4",
        "ai-model-id": modelId,
      };

      // v4 speaks "boolean"; pi's classifier questions use "bool". Callers
      // coming through the jev_ask habit (or ad-hoc scripts) sometimes send
      // "boolean"; normalize any bool-shaped question to the wire type rather
      // than letting it fall through to score.
      const wireTypes = new Map<string, "boolean" | "choice" | "score">();
      const questions = Object.fromEntries(
        Object.entries(context.questions).map(([id, question]) => {
          const { type, ...rest } = question as ClassifierQuestion & { type: string };
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

      const timeout = AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await requestFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        let message = `Aperture evaluation route returned HTTP ${response.status}`;
        if (response.status === 403) {
          message +=
            " — no direct_paths grant matches this identity and path; an Aperture admin must add a matching grant";
        } else if (detail) {
          message += `: ${detail.slice(0, 300)}`;
        }
        throw new Error(message);
      }
      const payload = (await response.json()) as V4Response;
      if (!payload.answers || typeof payload.answers !== "object") {
        throw new Error("Aperture evaluation route returned no answers");
      }
      const confidence = payload.providerMetadata?.typesafe?.confidence ?? {};
      const answers: ClassifierResult["answers"] = {};
      for (const [id, question] of Object.entries(context.questions)) {
        const answer = payload.answers[id];
        if (!answer) throw new Error(`Aperture evaluation route did not return an answer for ${id}`);
        const wire = wireTypes.get(id) ?? "score";
        if (wire === "boolean") {
          if (answer.type !== "boolean" || typeof answer.probability !== "number") {
            throw new Error(`Aperture evaluation route returned an invalid bool answer for ${id}`);
          }
          answers[id] = { type: "bool", probability: answer.probability };
        } else if (wire === "choice") {
          if (answer.type !== "choice" || typeof answer.choice !== "string") {
            throw new Error(`Aperture evaluation route returned an invalid choice answer for ${id}`);
          }
          answers[id] = {
            type: "choice",
            choice: answer.choice,
            probabilities: probabilities(answer.probabilities),
            confidence: numberOrZero(confidence[id]),
          };
        } else {
          if (answer.type !== "score" || typeof answer.score !== "number") {
            throw new Error(`Aperture evaluation route returned an invalid score answer for ${id}`);
          }
          answers[id] = { type: "score", score: numberOrZero(answer.score), confidence: numberOrZero(confidence[id]) };
        }
      }
      const usageIn = numberOrZero(payload.usage?.inputTokens);
      const usageOut = numberOrZero(payload.usage?.outputTokens);
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        answers,
        ...(usageIn || usageOut
          ? {
              usage: {
                input: usageIn,
                output: usageOut,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: usageIn + usageOut,
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
