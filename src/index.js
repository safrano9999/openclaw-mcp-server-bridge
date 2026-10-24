import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';
import { sendDurableMessageBatch, buildOutboundSessionContext } from 'openclaw/plugin-sdk/channel-outbound';
import { getSessionEntry, resolveStorePath, resolveSendPolicy } from 'openclaw/plugin-sdk/session-store-runtime';
import { registerBridge } from './bridge.js';
import { ID } from './state.js';
import manifest from '../openclaw.plugin.json' with { type: 'json' };

export default definePluginEntry({
  id: ID,
  name: 'OpenClaw MCP Server Bridge',
  description: 'In-process MCP access to selected agents and their admitted channel routes.',
  configSchema: manifest.configSchema,
  register(api) { registerBridge(api, { parseAgentSessionKey, sendDurableMessageBatch, buildOutboundSessionContext, getSessionEntry, resolveStorePath, resolveSendPolicy }); },
});
