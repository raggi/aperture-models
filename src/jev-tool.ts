import { Type } from "typebox";
import type { ClassifierModel } from "@earendil-works/pi-ai";
import { jevEvaluate, JEV_MODEL_ID, type JevEvalError } from "./classifier.js";

/**
 * The `jev_ask` judgment tool, folded in from the retired pi-jev extension.
 * Jev has no chat wire API, so chat models reach it through this tool, while
 * codemode scripts call the same evaluation through `models.classify()`.
 * Both surfaces share one wire implementation ({@link jevEvaluate}).
 *
 * The tool preserves pi-jev's contract exactly — same name, parameters,
 * result shape, state budget, and retry policy — so existing prompts and
 * habits keep working.
 */

/** The evaluation state and questions share ~32k tokens (~150,000 characters
 *  of English text) of request budget on jev-class models. Exceeding it is a
 *  request-validation failure, so refuse early with a clear error. */
export const DEFAULT_MAX_STATE_CHARS = 150_000;

export class StateTooLargeError extends Error {
  readonly stateChars: number;
  readonly limitChars: number;

  constructor(stateChars: number, limitChars: number) {
    super(
      `Jev state too large: ${stateChars} characters (state + questions) exceeds the ${limitChars}-character ` +
        `request budget. Summarize or split the state across requests.`,
    );
    this.name = "StateTooLargeError";
    this.stateChars = stateChars;
    this.limitChars = limitChars;
  }
}

export interface BackoffOptions {
  /** Total attempts including the first. Default 4. */
  attempts?: number;
  /** Initial delay in ms. Default 500. */
  baseDelayMs?: number;
  /** Maximum delay in ms. Default 8000. */
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Called instead of real sleeping; lets tests run without delays. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff over retryable {@link JevEvalError}s (transport
 *  failures, 429/529/5xx), honoring Retry-After when the error carries one. */
export async function withBackoff<T>(fn: (attempt: number) => Promise<T>, options: BackoffOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8000;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) throw new Error("Aborted before attempt");
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const retryable = (error as JevEvalError)?.retryable ?? true;
      if (!retryable || attempt === attempts) break;
      const advertised = (error as JevEvalError)?.retryAfterMs;
      const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(advertised ?? exponential);
    }
  }
  throw lastError;
}

const booleanQuestionSchema = Type.Object({
  type: Type.Literal("boolean"),
  instructions: Type.String({ description: "The complete yes/no question to evaluate" }),
  criteria: Type.Optional(
    Type.Object({
      true: Type.Optional(Type.String({ description: "What yes (near 1) means" })),
      false: Type.Optional(Type.String({ description: "What no (near 0) means" })),
    }),
  ),
});

const choiceQuestionSchema = Type.Object({
  type: Type.Literal("choice"),
  instructions: Type.String({ description: "What the model should decide" }),
  criteria: Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]), {
    description: "Option name → description; null when an option needs no detail",
  }),
});

const scoreQuestionSchema = Type.Object({
  type: Type.Literal("score"),
  instructions: Type.String({ description: "What the model should rate" }),
  criteria: Type.Array(Type.String(), {
    minItems: 2,
    description: "Ordered level descriptions; at least two",
  }),
});

const questionSchema = Type.Union([booleanQuestionSchema, choiceQuestionSchema, scoreQuestionSchema]);

export interface JevAskToolDependencies {
  /** Ambient credential for the evaluation route; defaults to
   *  APERTURE_API_KEY when set, otherwise the Tailscale identity marker. */
  apiKey?: string;
}

export function createJevAskTool(dependencies: JevAskToolDependencies = {}) {
  return {
    name: "jev_ask",
    label: "Jev judgment",
    description:
      "Ask the Jev evaluation model (System One) snap-judgment questions about a state and get structured, " +
      "calibrated answers: boolean (probability of yes), choice (option + full probability distribution + " +
      "confidence), or score (position on an ordered rubric + confidence). All questions run in parallel " +
      "against the same state in one request, so batch every question you might need — including speculative " +
      "ones — instead of calling once per question. Ask for judgments a knowledgeable person would make in a " +
      "few seconds; decompose complex judgments into several questions and combine the answers yourself.",
    promptSnippet: "Ask the Jev evaluation model calibrated yes/no, choice, or rubric-score questions",
    promptGuidelines: [
      "Use jev_ask when you need a structured judgment your code can branch, threshold, or sort on — not prose. " +
        "Batch related questions (including speculative ones) into a single jev_ask call.",
      "In jev_ask results, confidence (choice/score) tells you whether to act; low confidence means ask again, " +
        "gather more context, or escalate instead of trusting the answer. For boolean questions the probability " +
        "itself is the signal: near 0.5 means uncertain.",
    ],
    parameters: Type.Object({
      state: Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())], {
        description:
          "The content to evaluate: a message, passage, or structured application state. Object fields can be " +
          "referenced by dot-and-index path (with backticks) in question instructions.",
      }),
      questions: Type.Record(Type.String(), questionSchema, {
        description: "Question id → question. Every question is evaluated in parallel against the same state.",
      }),
    }),
    async execute(_toolCallId: string, params: { state: unknown; questions: Record<string, unknown> }, signal?: AbortSignal) {
      try {
        const questions = params.questions ?? {};
        if (!questions || Object.keys(questions).length === 0) {
          throw new Error("Jev request needs at least one question");
        }
        const stateChars = JSON.stringify(params.state ?? "").length + JSON.stringify(questions).length;
        if (stateChars > DEFAULT_MAX_STATE_CHARS) {
          throw new StateTooLargeError(stateChars, DEFAULT_MAX_STATE_CHARS);
        }
        const result = await withBackoff(
          () =>
            jevEvaluate(
              { id: JEV_MODEL_ID },
              { state: params.state, questions },
              {
                signal,
                ...(dependencies.apiKey ? { apiKey: dependencies.apiKey } : {}),
              },
            ),
          { signal },
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `jev_ask failed: ${message}` }],
          details: undefined,
          isError: true,
        };
      }
    },
  };
}

/** Test seam: the classifier model the tool routes through. */
export function jevAskModel(): ClassifierModel<"aperture-evaluation-v4"> {
  return {
    id: JEV_MODEL_ID,
    name: "Jev",
    type: "classifier",
    api: "aperture-evaluation-v4",
    input: ["text"],
    baseUrl: "https://ai.corp.ts.net",
    provider: "typesafe-ai",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
  };
}
