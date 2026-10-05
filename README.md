# pi-aperture-models

A Pi extension that discovers models from the Tailscale Aperture catalog instead
of duplicating its model list in `~/.pi/agent/models.json`.

## Behavior

- Fetches `https://ai.corp.ts.net/v1/models` during extension startup.
- Falls back to `~/.cache/pi-aperture-models/catalog.json` when Aperture is unavailable.
- Registers each `metadata.provider.id` as a Pi provider, preserving Aperture's
  backing-route identity, pricing, retention, quota, and routing semantics.
- Preserves the same model ID when it is offered by multiple backing routes.
- Chooses each model's wire protocol independently, in preference order:
  1. OpenAI Responses
  2. OpenAI Chat Completions
  3. Anthropic Messages
- Reuses Pi built-in metadata when an exact or provider-prefixed model match is
  available, while the route-specific catalog limits and prices remain authoritative.
- Refreshes all backing providers from one coalesced catalog request when Pi
  refreshes model catalogs.
- Registers the TypeSafe Jev evaluation model (`typesafe-ai/jev`) as a
  classifier provider, reachable from codemode via `models.classify()`.
- Registers the `jev_ask` judgment tool for chat models (same name, parameters,
  and result shape as the retired pi-jev extension), sharing one wire
  implementation with the classifier.
- Prunes stale entries from `~/.pi/agent/models-store.json` at startup: cached
  catalogs for backing routes the catalog no longer projects (Aperture renames
  or retires routes over time). Only Aperture-lineage entries are removed; a
  rolling `models-store.json.aperture-backup` is kept before the first
  mutation.

Backing IDs are preserved exactly. IDs such as `anthropic` and `openrouter`
therefore intentionally override Pi's built-in providers while this extension
is enabled: they mean those backing routes through Aperture, not direct public
API access.

## pi-ai import surfaces

Import `@earendil-works/pi-ai` only from the root (types plus runtime
re-exports), `/compat` (API adapters), and `/providers/all` (builtin
catalogs). Never import other pi-ai subpaths (`/api/*`, `/utils/*`):
extension loaders that run extensions through jiti's alias map — SDK and
runner-hosted child sessions — prefix-replace the package specifier, so
unaliased subpaths mangle into broken module paths and the extension fails
to load exactly where background subagents need it.

Aperture normally uses Tailscale identity and needs no API key. In that mode the
extension sends the non-secret marker `Authorization: Tailscale` to satisfy the
client SDKs' auth guards; Aperture authenticates the connection by Tailscale
identity and ignores the marker value. If a deployment requires a key, set
`APERTURE_API_KEY` to use the protocol adapter's normal key handling.

## Develop and verify

The development SDK is pinned to Pi **1.0.4**. Background child loading is
live-verified with **pi-subagents 0.76.0**. On Pi 1.0.x, use pi-subagents
**0.75.0 or newer**: 0.74.0 requires the removed `pi-agent-core/node` export
and fails before loading this provider. Keep the alias-safe imports above;
that earlier provider-loader fix is still required independently.

```sh
npm install
npm run validate
curl -fsS https://ai.corp.ts.net/v1/models -o /tmp/aperture-models.json
APERTURE_FIXTURE=/tmp/aperture-models.json npm test
PI_CODING_AGENT_DIR="$(mktemp -d)" pi -e ./src/index.ts --list-models
```

For isolated request tests, create a temporary Pi config directory with the
extension enabled and select a discovered provider/model explicitly.

## Install only after validation

From this directory:

```sh
pi install "$(pwd)"
pi list
```

Then remove old manually enumerated Aperture providers from
`~/.pi/agent/models.json` (back it up first). The extension supplies provider
and model definitions dynamically, so no model entries are needed there.

Suggested defaults in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "openai-api",
  "defaultModel": "gpt-5.6-sol"
}
```

Use `/reload` or reopen `/model` to refresh the remote catalog.
