import { JEV_MODEL_ID, JEV_PROVIDER_ID } from "../src/classifier.js";
import type { ClassifierModel } from "@earendil-works/pi-ai";

/** Mirrors the jevClassifierModel() projection registered by the extension. */
export function jevClassifierModel(): ClassifierModel<"aperture-evaluation-v4"> {
  return {
    id: JEV_MODEL_ID,
    name: "Jev",
    type: "classifier",
    api: "aperture-evaluation-v4",
    input: ["text"],
    baseUrl: "https://ai.corp.ts.net",
    provider: JEV_PROVIDER_ID,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
  };
}
