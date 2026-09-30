import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { APERTURE_ORIGIN } from "./catalog.js";

/**
 * The models store (`~/.pi/agent/models-store.json`) caches refreshed provider
 * catalogs keyed by provider id. Aperture routes churn (e.g. vercel-ent →
 * vercel-ent-zdr); when a backing route disappears, the extension simply stops
 * registering it and its store entry lingers forever: pi has no store-pruning
 * API, and a provider's `publish()` can only touch its own key.
 *
 * This reconcile keeps the store tidy as part of the extension's own updates.
 * It deletes only entries it can positively identify as stale Aperture
 * lineage: every stored model's baseUrl points at the Aperture origin and the
 * provider id is absent from the freshly projected catalog. Entries for
 * currently projected routes (the extension refreshes them itself) and for
 * foreign, non-Aperture catalogs are never touched.
 */
export interface ReconcileResult {
  removed: string[];
}

export function modelsStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDir, "models-store.json");
}

function isApertureLineage(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const models = (entry as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length === 0) return false;
  return models.every(
    (model) =>
      !!model &&
      typeof model === "object" &&
      typeof (model as { baseUrl?: unknown }).baseUrl === "string" &&
      (model as { baseUrl: string }).baseUrl.startsWith(APERTURE_ORIGIN),
  );
}

/**
 * Reads the store, removes stale Aperture-lineage entries for provider ids the
 * current catalog no longer projects, and writes the result back atomically.
 * Never throws: the store is a cache, and a failed reconcile must not break
 * extension startup. Returns the removed provider ids.
 */
export async function reconcileApertureStore(
  projectedProviderIds: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReconcileResult> {
  const removed: string[] = [];
  try {
    const path = modelsStorePath(env);
    const document = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (!document || typeof document !== "object" || Array.isArray(document)) return { removed };

    for (const [providerId, entry] of Object.entries(document)) {
      if (projectedProviderIds.has(providerId)) continue;
      if (isApertureLineage(entry)) removed.push(providerId);
    }
    if (!removed.length) return { removed };

    // One rolling backup before the first mutation of this reconcile.
    await copyFile(path, `${path}.aperture-backup`).catch(() => undefined);

    for (const providerId of removed) delete document[providerId];
    const temporary = `${path}.${process.pid}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch {
    // Cache hygiene is best-effort; any failure leaves the store untouched.
  }
  return { removed };
}
