# pi-openai-fast

OpenAI Codex Fast mode for [Pi](https://github.com/earendil-works/pi-mono), with current GPT-5.6 model support.

When enabled, this extension adds the priority service tier to eligible OpenAI Codex requests:

```json
{
  "service_tier": "priority"
}
```

## Supported models

The extension follows the Fast-mode capability metadata advertised by Codex:

- GPT-5.4
- GPT-5.5
- GPT-5.6 Sol
- GPT-5.6 Terra
- GPT-5.6 Luna

The allowlist is deliberate. Models that do not advertise Fast mode, including GPT-5.4 mini and GPT-5.3 Codex Spark, are left unchanged.

Fast mode requires ChatGPT OAuth authentication. API-key requests and other providers are never modified.

## Install

### npm

```bash
pi install npm:@mjakl/pi-openai-fast
```

### GitHub

```bash
pi install git:github.com/mjakl/pi-openai-fast
```

### Local checkout

```bash
pi install /path/to/pi-openai-fast
```

Reload Pi after installation:

```text
/reload
```

Disable Diego Petrucci's original `openai-fast` resource if you already load the `@diegopetrucci/pi-extensions` collection. Loading both creates duplicate `/fast` commands; `pi config` can disable the original resource without removing the rest of the collection.

## Usage

Fast mode defaults to off because it consumes credits faster than standard requests.

```text
/fast on       Enable Fast mode for this session
/fast off      Disable Fast mode for this session
/fast status   Show the current state and model eligibility
/fast          Toggle the current state
```

The status area shows `fast` while the selected model is eligible and Fast mode is active.

## Configuration

Set a default globally in:

```text
~/.pi/agent/extensions/openai-fast.json
```

Or for a trusted project in:

```text
.pi/openai-fast.json
```

```json
{
  "enabled": false,
  "showStatus": true
}
```

Project settings override global settings. `/fast on` and `/fast off` are session-only overrides.

## Safety boundaries

The extension injects `service_tier=priority` only when all of these are true:

- Fast mode is enabled.
- The provider is `openai-codex`.
- The API is `openai-codex-responses`.
- The selected model advertises Codex Fast mode.
- Pi reports that the model is using ChatGPT OAuth.
- The payload model matches the selected model.
- The payload does not already set `service_tier`.

An existing service tier always wins, which keeps this extension compatible with future first-class Pi support.

## Maintenance

The supported-model allowlist lives at the top of [`index.ts`](./index.ts). Compare it with Codex's [`models.json`](https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json): models whose `service_tiers` include `priority` / `Fast` belong in the list.

```bash
npm install
npm run check
```

## Attribution

Based on Diego Petrucci's [`openai-fast`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/openai-fast) extension. The original MIT copyright notice is preserved in [`LICENSE`](./LICENSE).

## License

MIT
