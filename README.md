# pi-aperture-models

A Pi extension that discovers models from the Tailscale Aperture catalog instead
of duplicating its model list in `~/.pi/agent/models.json`.

## Behavior

- Fetches `https://ai.corp.ts.net/v1/models` during extension startup.
- Falls back to `~/.cache/pi-aperture-models/catalog.json` when Aperture is unavailable.
- Assigns every model ID exactly once, in protocol preference order:
  1. OpenAI Responses
  2. OpenAI Chat Completions
  3. Anthropic Messages
- Registers `aperture-responses`, `aperture-completions`, and
  `aperture-anthropic`.
- Reuses Pi built-in metadata when an exact or provider-prefixed model match is
  available, while catalog limits and prices remain authoritative.
- Refreshes all three providers from one coalesced catalog request when Pi
  refreshes model catalogs.

Aperture normally uses Tailscale identity and needs no API key. In that mode the
extension sends the non-secret marker `Authorization: Tailscale` to satisfy the
client SDKs' auth guards; Aperture authenticates the connection by Tailscale
identity and ignores the marker value. If a deployment requires a key, set
`APERTURE_API_KEY` to use the protocol adapter's normal key handling.

## Develop and verify

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

Then replace the old manually enumerated Aperture providers in
`~/.pi/agent/models.json` (back it up first). The extension itself supplies the
three provider definitions, so no model entries are needed there.

Suggested defaults in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "aperture-responses",
  "defaultModel": "gpt-5.6-sol"
}
```

Use `/reload` or reopen `/model` to refresh the remote catalog.
