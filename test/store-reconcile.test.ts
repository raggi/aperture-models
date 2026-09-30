import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelsStorePath, reconcileApertureStore } from "../src/store-reconcile.js";

const APERTURE = "https://ai.corp.ts.net/v1";

function envWith(dir: string): NodeJS.ProcessEnv {
  return { PI_CODING_AGENT_DIR: dir } as NodeJS.ProcessEnv;
}

async function writeStore(dir: string, document: unknown): Promise<string> {
  const path = modelsStorePath(envWith(dir));
  await writeFile(path, JSON.stringify(document, null, 2));
  return path;
}

test("reconcile removes only stale Aperture-lineage entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aperture-store-"));
  const path = await writeStore(dir, {
    "vercel-ent": { models: [{ id: "old", baseUrl: APERTURE, api: "openai-responses" }], checkedAt: 1 },
    neuralwatt: { models: [{ id: "glm", baseUrl: APERTURE, api: "openai-completions" }], checkedAt: 2 },
    "vercel-ent-zdr": { models: [{ id: "kept", baseUrl: APERTURE, api: "openai-responses" }], checkedAt: 3 },
    anthropic: { models: [{ id: "direct", baseUrl: "https://api.anthropic.com/v1" }], checkedAt: 4 },
    empty: { models: [], checkedAt: 5 },
  });

  const { removed } = await reconcileApertureStore(new Set(["vercel-ent-zdr"]), envWith(dir));
  assert.deepEqual(removed.sort(), ["neuralwatt", "vercel-ent"]);

  const after = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(Object.keys(after).sort(), ["anthropic", "empty", "vercel-ent-zdr"]);
});

test("reconcile is a no-op when every Aperture entry is still projected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aperture-store-"));
  const path = await writeStore(dir, {
    "vercel-ent-zdr": { models: [{ id: "kept", baseUrl: APERTURE, api: "openai-responses" }], checkedAt: 1 },
    openai: { models: [{ id: "direct", baseUrl: "https://api.openai.com/v1" }], checkedAt: 2 },
  });

  const { removed } = await reconcileApertureStore(new Set(["vercel-ent-zdr"]), envWith(dir));
  assert.deepEqual(removed, []);
  const after = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(Object.keys(after).sort(), ["openai", "vercel-ent-zdr"]);
});

test("reconcile survives a missing or malformed store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aperture-store-"));
  const missing = await reconcileApertureStore(new Set(["x"]), envWith(dir));
  assert.deepEqual(missing.removed, []);

  const broken = await mkdtemp(join(tmpdir(), "aperture-store-"));
  await writeFile(modelsStorePath(envWith(broken)), "{not json");
  const result = await reconcileApertureStore(new Set(["x"]), envWith(broken));
  assert.deepEqual(result.removed, []);
});

test("reconcile keeps a rolling backup before mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aperture-store-"));
  const path = await writeStore(dir, {
    stale: { models: [{ id: "old", baseUrl: APERTURE, api: "openai-completions" }], checkedAt: 1 },
  });

  await reconcileApertureStore(new Set(), envWith(dir));
  const backup = JSON.parse(await readFile(`${path}.aperture-backup`, "utf8"));
  assert.deepEqual(Object.keys(backup), ["stale"]);
});
