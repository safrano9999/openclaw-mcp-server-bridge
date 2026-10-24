# OpenClaw MCP Server Bridge

A private, in-process MCP endpoint for controlling selected OpenClaw agents through their existing messaging channels. Telegram keeps OpenClaw’s bot accounts, admission rules, pairing and bindings. The bridge adds no bot poller, container or listening port.

## Configure selected agents

The extension’s `env.example` defines the injected CSV:

```dotenv
OPENCLAW_MCP_BRIDGE_AGENTS=carassistant
```

Use existing OpenClaw agent IDs. An explicitly blank value clears the selection; an absent variable leaves independently managed configuration intact. Unknown IDs fail initialization before configuration is changed.

Run the extension-owned init after `openclaw-ephemeral configure` has generated `openclaw.json` and before starting the gateway:

```sh
python3 image/init/20-openclaw-mcp-bridge.py
```

The init uses the native `openclaw config set --strict-json` writer to update only `plugins.entries.openclaw-mcp-server-bridge.config.agentIds`. It preserves other plugin settings, credentials, routing and account configuration. Repeated runs with the same selection do nothing.

For Fedora’s existing init-hook runner, install the script under `/usr/local/share/fedora45-ai/init.d/OPENLAW/20-openclaw-mcp-bridge.py`. The same script works on bare metal with Python 3 and OpenClaw on `PATH`. Use the existing `OPENCLAW_CONFIG` or `OPENCLAW_CONFIG_PATH` to select the configuration file. A CSV in an environment file must be injected into the init process; the script does not source arbitrary shell files.

At gateway startup the bridge creates a random 256-bit bearer for each selected agent using OpenClaw’s transactional config API. Removed agents lose access. Credentials belong to runtime state and must never be included in an image or Git.

```sh
openclaw mcp-bridge status
openclaw mcp-bridge client-config carassistant --url https://your-gateway.example
```

`client-config` deliberately outputs that agent’s bearer. Keep it private. The MCP endpoint is `/telegram-mcp` on the existing gateway; remote access uses its existing HTTPS proxy.

## FIFO and current destination

Each agent has its own FIFO and exactly one current return route, `actual_channel`. Every accepted incoming message creates one FIFO entry and replaces that agent’s current route with its complete source: channel, account, destination, thread and session.

For example, messages arriving through Telegram, then Discord, leave Discord as the current outgoing destination. Reading or draining older FIFO entries never changes the current route. Different agents keep independent queues and destinations.

There is no historical route selector. `send_message` accepts only text and always uses the most recently accepted source. The client cannot supply a chat ID or choose an older message’s destination. A restart, routing configuration change, expired route or session reset requires a fresh admitted incoming message. A send whose destination changes before platform handoff is rejected rather than delivered to an outdated target.

| Tool | Input | Behavior |
| --- | --- | --- |
| `new_message` | Optional `count`, 1–100; default 1 | Atomically consume the oldest entries from this agent’s FIFO. |
| `pending_count` | None | Read pending, overflow, expiry and duplicate counters. |
| `send_message` | `text` | Send text to this agent’s current return route. |

An entry contains its ID, sequence, receipt time, text, truncation flag and original source metadata. Source metadata describes the incoming message; it does not select the outgoing destination. Message text is untrusted user content. Local paths, signed download URLs, tokens and internal history/prompt envelopes are excluded. Media binaries and outgoing attachments are outside this release.

## Delivery and lifetime

Each agent retains at most 1,000 messages / 8 MiB, with 32,768 characters per text and at most 8,192 deduplication identities. At most 64 agents are selected. Overflow drops the oldest entries and increments a counter. Messages and the current route expire after 24 hours. Disconnecting an MCP client keeps the queue; restarting the gateway or bridge clears it.

Consumption is **at most once**: entries removed by `new_message` are not replayed after a lost HTTP response. Concurrent clients of the same agent share the queue and receive disjoint entries. There is no persistent inbox or acknowledgement protocol.

Outgoing text uses OpenClaw’s public durable delivery API. `sent` means the host confirmed delivery. `suppressed`, `partial_failed` and `delivery_unknown` do not mean complete success. The bridge never blindly retries uncertain delivery.

## Boundaries

The bearer identifies one agent. Every request and platform handoff checks that principal again. Host admission, Telegram pairing/allowlists, bindings, native commands, session generation and send policy remain authoritative. Selected ordinary agent dispatches are taken over before an LLM reply; unrelated agents retain normal behavior.

The HTTP endpoint requires a bearer, accepts JSON POST requests and rejects JSON-RPC batches. GET/DELETE return 405 after authentication. Browser origins are denied unless explicitly configured. Limits are 128 KiB per request, 64 simultaneous requests, eight sends per agent and a 60-second request timeout. TLS and public rate limiting belong to the existing gateway infrastructure.

Current takeover support targets admitted channel dispatches, primarily Telegram. Webchat/WebUI, ACP, cron/heartbeat and host-excluded runtimes are outside the supported takeover path. No model call is needed to queue a captured message or send MCP text.

## Install and release

```sh
sha256sum -c openclaw-mcp-server-bridge-latest.zip.sha256
openclaw plugins install --force --accept-capabilities ./openclaw-mcp-server-bridge-latest.zip
```

The ZIP includes the compiled extension, dependency license notices, `env.example` and the init script. MCP SDK 1.30.0 and Zod are bundled; public `openclaw/plugin-sdk/*` imports come from the host. No plugin-local dependency install is needed.

GitHub Actions verifies OpenClaw **2026.9.4** and **2026.10.6**, including public SDK imports, ZIP installation and isolated gateway startup. Unit tests cover FIFO order, the latest-source destination, agent isolation, admission, delivery policy and injected initialization. Production Telegram acceptance remains a separate live test.

Workflow source of truth: `SCRIPTS/githubactions/openclaw-mcp-server-bridge`; shared packaging: `SCRIPTS/githubactions/_shared/scripts/openclaw_plugin_zip.sh`. Container images are built only by the existing Fedora GitHub Actions, published to GHCR and pulled only through Smart1.
