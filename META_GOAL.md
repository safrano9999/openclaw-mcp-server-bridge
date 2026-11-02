# Scope

Provide a generic OpenClaw MCP server and deterministic outbound bridge. Shared optional bearer authentication, caller-selected routing, configured defaults, native durable delivery and private handler state form one plugin installed from Core onward.

Omitted selectors and explicit `default` are equivalent. No application-specific agent or channel is hardcoded. OwnTracks selects its agent in its own configuration. LiteLLM-Free supplies a Python handler from its public source repository and sends no routing selectors.

Publish verified runtime and example archives through GitHub Actions. Build container consumers only on GitHub-hosted runners.
