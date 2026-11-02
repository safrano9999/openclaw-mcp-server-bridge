
# OpenClaw MCP server bridge

One OpenClaw plugin provides a Streamable HTTP MCP server at `/mcp`, direct notifications at `/mcp/direct`, and named Python event handlers. Installed from Core onward.

## Authentication and defaults

`OPENCLAW_MCP_BRIDGE_BEARER` is one shared server credential. When absent or empty, authentication is disabled; there is no additional auth switch. A configured bearer is mandatory on every API request. The browser landing page contains no private data.

`OPENCLAW_DEFAULT_AGENT` (default `main`) is written by openclaw-ephemeral to `agents.defaults.systemAgent.agentId`. It must name an existing agent. `OPENCLAW_DEFAULT_CHANNEL` optionally prefers a channel for that agent; otherwise the bridge requires an unambiguous channel binding.

For all routing arguments, omission and the literal `default` mean the same thing:
- `agent`: configured default agent, falling back to `main`.
- `session`: the selected agent's main session.
- `channel`: preferred channel or unique matching binding.
- `accountId`: the matching account binding, respecting the channel's configured default.
- `target`: a unique peer binding, or that session's saved destination for the same channel/account.
- `threadId`: the saved thread for the same destination.

Concrete arguments override defaults. `channel: "last"` explicitly selects the session's latest route. Missing or ambiguous destinations return an error; a different channel/account's destination is never silently reused. Fresh send policy and routing are checked at delivery.

## Direct notifications

Enable `OPENCLAW_MCP_BRIDGE_DIRECT=true`:

```sh
curl -sS "$OPENCLAW_URL/mcp/direct" \
  -H "Authorization: Bearer $OPENCLAW_MCP_BRIDGE_BEARER" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello"}'
```

The same request with `"agent":"default","channel":"default"` resolves identically. An OwnTracks caller can instead send `"agent":"carassistant"`; that choice belongs to the caller.

`OPENCLAW_MCP_BRIDGE_DIRECT_FIFO=true` additionally queues plain webhook text for MCP consumers. `event_id` deduplicates these queued inputs. Delivery does not invoke an LLM.

## MCP tools

- `new_message`: consume admitted inbound messages for an optional agent.
- `pending_count`: inspect that agent's queue without consuming.
- `send_message`: send text using the routing arguments above.
- Named Python handlers, including `litellm-free`.

Admitted inbound channel messages are observed without suppressing normal agent replies. Queues are bounded and cleared on restart; destination state persists. Consuming messages does not change the destination. Unknown/partial delivery is never automatically retried.

## Python handlers

Each `extensions/NAME/NAME.py` has a `NAME.json` configuration. The filename becomes the MCP tool name. Handlers receive JSON on stdin and return JSON on stdout; the bridge owns authentication and native channel delivery. Calls are serialized per handler. Attachments must reside beneath the handler's private state directory.

The LiteLLM-Free source lives in [f24sales/litellm-free](https://github.com/f24sales/litellm-free/tree/master/mcp), pinned by commit during the release build. Its refresh scripts and metadata library are bundled into the ZIP. It handles import results, refreshes client catalogs, and sends scan PDFs and model diffs:

```json
{"tool":"litellm-free","payload":{"schema_version":1,"source":"litellm-free","event":"import_failed","event_id":"example-1"}}
```

POST this object to `/mcp/direct`, or call the `litellm-free` MCP tool with `payload`. No routing selector is required. State and receipts live under `<OPENCLAW_STATE_DIR>/openclaw-mcp-server-bridge/litellm-free/`. Refresh success and notification delivery are reported separately. Duplicate or uncertain sends are not blindly repeated.

## Installation and verification

Install the release ZIP with OpenClaw's plugin installer. The image initializer applies injected bridge settings after openclaw-ephemeral configuration. It removes obsolete per-agent credential settings; migration requires the shared bearer to be injected.

GitHub Actions tests routing, auth, MCP, initialization, Python handlers, exact public SDK integration and two gateway starts on OpenClaw 2026.9.4 and 2026.10.6 before publishing the ZIP and SHA256. Runtime and example ZIPs are separate release assets.

`openclaw mcp-bridge status` shows routing configuration without secrets.
`openclaw mcp-bridge client-config --url https://gateway.example` intentionally prints client credentials for local configuration.
