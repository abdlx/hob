import { HermesError, hermesProfile, hermesResource } from './hermes-client.mjs';
import { MANAGED_ENV } from './hermes-routes.mjs';
import { containsStoredSecret } from './hermes-settings.mjs';
import { hermesMemorySetup } from './hermes-memory-setup.mjs';
import { hermesLearningSetup } from './hermes-learning-setup.mjs';
import { createHermesPluginsRoutes } from './hermes-plugins.mjs';

const invalid = message => new HermesError(400, message, 'INVALID_REQUEST');
const valueText = (value, max = 64000) => typeof value === 'string' && value.length <= max;
const identifier = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw invalid('Invalid setup identifier.');
  return hermesResource(value);
};
const project = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const envInput = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 128
    || Object.entries(value).some(([key, entry]) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || MANAGED_ENV.test(key) || !valueText(entry) || containsStoredSecret(entry))) {
    throw invalid('Enter only this integration’s credential fields, not managed deployment variables.');
  }
  return value;
};
const managedChannel = name => ['api_server', 'webhook'].includes(name);

/** Native setup forms; never shell commands, arbitrary URLs, or a second config owner. */
export function createHermesSetupRoutes(client, { mcpOAuth } = {}) {
  const plugins = createHermesPluginsRoutes();
  return async (req, res, url, { json, body }) => {
    const route = url.pathname.slice('/api/hermes/setup/'.length), method = req.method;
    const profiles = url.searchParams.getAll('profile');
    if (profiles.length > 1) throw invalid('Select one bot.');
    const profile = hermesProfile(profiles[0] ?? 'default');
    if (profile === 'all') throw invalid('Select one bot.');
    await client.credentialBinding(profile);
    const dashboard = (path, options = {}) => client.dashboard(path, { ...options, profile });
    const input = async fields => {
      const value = await body(req);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => ![...fields, 'profile'].includes(key))
        || ('profile' in value && value.profile !== profile)) throw invalid('Invalid setup request or bot selector.');
      const { profile: _profile, ...result } = value;
      return result;
    };
    if (route === 'plugins' || route.startsWith('plugins/')) return plugins(route, method, { profile, dashboard, input, json, res });
    if (route === 'memory' || route.startsWith('memory/')) return hermesMemorySetup(route, method, { dashboard, input, json, res });
    if (route === 'learning') return hermesLearningSetup(method, { dashboard, input, json, res, profile });
    if (route === 'mcp/oauth/flows' && method === 'GET' && mcpOAuth) return json(res, 200, await mcpOAuth.list(profile));
    const oauthFlow = /^mcp\/oauth\/flows\/([a-zA-Z0-9_-]{1,128})$/.exec(route);
    if (oauthFlow && mcpOAuth) {
      if (method === 'GET') return json(res, 200, await mcpOAuth.poll(oauthFlow[1], profile));
      if (method === 'DELETE') { await input([]); return json(res, 200, await mcpOAuth.cancel(oauthFlow[1], profile)); }
    }
    const oauthStart = /^mcp\/([^/]+)\/auth$/.exec(route);
    if (oauthStart && method === 'POST' && mcpOAuth) {
      const value = await input(['confirm']);
      if (value.confirm !== true) throw invalid('Confirm starting sign-in for this bot’s MCP server.');
      let name;
      try { name = decodeURIComponent(oauthStart[1]); } catch { throw invalid('Invalid MCP server name.'); }
      return json(res, 200, await mcpOAuth.start(name, profile));
    }
    if (route === 'mcp' && method === 'GET') {
      const result = await dashboard('/api/mcp/servers');
      if (!Array.isArray(result.servers)) throw new HermesError(502, 'Hermes returned an invalid MCP inventory.', 'HERMES_PROTOCOL_ERROR');
      return json(res, 200, { servers: result.servers.map(item => ({
        ...project(item, ['name', 'transport', 'auth', 'enabled', 'source', 'plugin']),
        envKeys: Object.keys(item.env || {}), argumentCount: Array.isArray(item.args) ? item.args.length : 0,
      })) });
    }
    if (route === 'mcp' && method === 'POST') {
      const value = await input(['name', 'url', 'command', 'args', 'env', 'auth', 'bearer_token', 'confirm']);
      if (value.confirm !== true) throw invalid('Confirm authorizing this MCP server. Hermes may run its executable or contact its endpoint.');
      hermesResource(value.name);
      const hasUrl = valueText(value.url) && Boolean(value.url.trim()), hasCommand = valueText(value.command, 4096) && Boolean(value.command.trim());
      if (hasUrl === hasCommand || (value.url !== undefined && !valueText(value.url)) || (value.command !== undefined && !valueText(value.command, 4096))) throw invalid('Provide exactly one MCP endpoint or executable.');
      if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 128 || value.args.some(item => !valueText(item, 4096)))) throw invalid('MCP arguments must be a bounded list of strings.');
      if (value.env !== undefined) envInput(value.env);
      const auth = value.auth ?? 'none';
      if (!['none', 'header', 'oauth'].includes(auth)) throw invalid('Select a supported MCP authentication mode.');
      if (hasUrl) {
        let endpoint;
        try { endpoint = new URL(value.url); } catch { throw invalid('Enter an HTTP or HTTPS MCP endpoint.'); }
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw invalid('Enter an HTTP or HTTPS endpoint without embedded credentials or a fragment.');
        if (value.args?.length || Object.keys(value.env || {}).length) throw invalid('Arguments and environment fields belong to local MCP executables.');
      } else if (auth !== 'none' || value.bearer_token !== undefined) throw invalid('Local MCP servers use environment credentials, not HTTP authentication.');
      if (auth === 'header' && (!valueText(value.bearer_token) || !value.bearer_token.trim() || containsStoredSecret(value.bearer_token))) throw invalid('Enter the MCP bearer credential.');
      if (auth !== 'header' && value.bearer_token !== undefined) throw invalid('Bearer credentials require header authentication.');
      const { confirm: _confirm, ...create } = value;
      await dashboard('/api/mcp/servers', { method, body: { ...create, auth, profile } });
      return json(res, 201, { ok: true });
    }
    const mcp = /^mcp\/([^/]+)(?:\/(enabled|test))?$/.exec(route);
    if (mcp) {
      let decoded;
      try { decoded = decodeURIComponent(mcp[1]); } catch { throw invalid('Invalid MCP server name.'); }
      const name = hermesResource(decoded);
      if (mcp[2] === 'enabled' && method === 'PUT') {
        const value = await input(['enabled', 'confirm']);
        if (typeof value.enabled !== 'boolean' || (value.enabled && value.confirm !== true)) throw invalid('Confirm enabling the MCP server.');
        await dashboard(`/api/mcp/servers/${name}/enabled`, { method, body: { enabled: value.enabled, profile } });
        return json(res, 200, { ok: true, enabled: value.enabled });
      }
      if (mcp[2] === 'test' && method === 'POST') {
        const value = await input(['confirm']);
        if (value.confirm !== true) throw invalid('Confirm connecting to the MCP server for a tool probe.');
        const result = await dashboard(`/api/mcp/servers/${name}/test`, { method });
        return json(res, 200, { ok: result.ok === true,
          ...(result.ok === true ? { tools: (result.tools || []).map(item => project(item, ['name', 'description', 'schema_chars'])), prompts: result.prompts, resources: result.resources }
            : { error: 'Hermes could not complete the MCP connection. Check this bot’s server setup and authentication.' }) });
      }
      if (!mcp[2] && method === 'DELETE') {
        const value = await input(['confirm']);
        if (value.confirm !== true) throw invalid('Confirm removing this bot’s MCP server configuration.');
        await dashboard(`/api/mcp/servers/${name}`, { method });
        return json(res, 200, { ok: true });
      }
    }
    if (route === 'models' && method === 'GET') {
      const refresh = url.searchParams.get('refresh');
      if (refresh !== null && !['true', 'false'].includes(refresh)) throw invalid('Refresh must be true or false.');
      const result = await dashboard('/api/model/options', { query: { include_unconfigured: true, explicit_only: true, refresh: refresh === 'true' } });
      return json(res, 200, { ...project(result, ['provider', 'model']), providers: (result.providers || []).map(item => ({
        ...project(item, ['slug', 'name', 'authenticated', 'key_env', 'warning']),
        models: (item.models || []).map(model => typeof model === 'string' ? model : project(model, ['id', 'name'])),
      })) });
    }
    if (route === 'tools' && method === 'GET') return json(res, 200, await dashboard('/api/tools/toolsets'));
    const tool = /^tools\/([a-z0-9_-]+)(?:\/(config|provider|credentials|install))?$/.exec(route);
    if (tool) {
      const name = identifier(tool[1]);
      if (tool[2] === 'config' && method === 'GET') return json(res, 200, await dashboard(`/api/tools/toolsets/${name}/config`));
      if (method === 'PUT' && !tool[2]) {
        const value = await input(['enabled', 'confirm']);
        if (typeof value.enabled !== 'boolean' || (value.enabled && value.confirm !== true)) throw invalid('Confirm enabling this toolset and any native dependency setup.');
        return json(res, 200, await dashboard(`/api/tools/toolsets/${name}`, { method, body: { enabled: value.enabled, profile } }));
      }
      if (tool[2] === 'credentials' && method === 'PUT') {
        const value = await input(['env']); envInput(value.env);
        return json(res, 200, await dashboard(`/api/tools/toolsets/${name}/env`, { method, body: { env: value.env, profile } }));
      }
      if (tool[2] === 'provider' && method === 'PUT') {
        const value = await input(['provider', 'capability']);
        if (!valueText(value.provider, 256) || !value.provider.trim() || ('capability' in value && !['search', 'extract'].includes(value.capability))) throw invalid('Select a native tool provider.');
        return json(res, 200, await dashboard(`/api/tools/toolsets/${name}/provider`, { method, body: { ...value, profile } }));
      }
      if (tool[2] === 'install' && method === 'POST') {
        const value = await input(['key', 'confirm']);
        if (value.confirm !== true || !valueText(value.key, 128)) throw invalid('Confirm native dependency setup.');
        const matrix = await dashboard(`/api/tools/toolsets/${name}/config`);
        if (!matrix.providers?.some(item => item.post_setup === value.key)) throw invalid('This setup action does not belong to the selected toolset.');
        return json(res, 202, await dashboard(`/api/tools/toolsets/${name}/post-setup`, { method, body: { key: value.key, profile } }));
      }
    }
    if (route === 'channels' && method === 'GET') {
      const result = await dashboard('/api/messaging/platforms');
      if (!Array.isArray(result.platforms)) throw new HermesError(502, 'Hermes returned an invalid channel catalog.', 'HERMES_PROTOCOL_ERROR');
      return json(res, 200, { platforms: result.platforms.filter(item => !managedChannel(item.id)).map(item => ({
        ...project(item, ['id', 'name', 'description', 'enabled', 'configured', 'state', 'docs_url']),
        env_vars: (item.env_vars || []).filter(field => !MANAGED_ENV.test(field.key)).map(field => ({
          ...project(field, ['key', 'prompt', 'description', 'help', 'is_set', 'required', 'is_password', 'is_list', 'advanced']),
          // Never return native redacted prefixes. Only allowlist IDs are editable reads.
          ...(field.is_list === true && field.is_password !== true && valueText(field.value) ? { value: field.value } : {}),
        })),
      })) });
    }
    const channel = /^channels\/([a-z0-9_-]+)(?:\/(test))?$/.exec(route);
    if (channel && !managedChannel(channel[1])) {
      const name = identifier(channel[1]);
      if (method === 'PUT' && !channel[2]) {
        const value = await input(['enabled', 'env', 'confirm']);
        if ('enabled' in value && (typeof value.enabled !== 'boolean' || (value.enabled && value.confirm !== true))) throw invalid('Confirm connecting this messaging channel.');
        if ('env' in value) envInput(value.env);
        const { confirm: _confirm, ...change } = value;
        return json(res, 200, await dashboard(`/api/messaging/platforms/${name}`, { method, body: { ...change, profile } }));
      }
      if (channel[2] === 'test' && method === 'POST') {
        await input([]);
        const result = await dashboard(`/api/messaging/platforms/${name}/test`, { method });
        return json(res, 200, project(result, ['ok', 'platform', 'status', 'configured', 'gateway_running', 'state', 'missing', 'warnings', 'checks']));
      }
    }
    if (route === 'accounts' && method === 'GET') {
      const result = await dashboard('/api/providers/oauth');
      return json(res, 200, { providers: (result.providers || []).map(item => ({
        ...project(item, ['id', 'name', 'flow', 'docs_url', 'disconnectable', 'disconnect_hint']),
        status: project(item.status, ['logged_in', 'source', 'expires_at', 'configured']),
      })) });
    }
    const account = /^accounts\/([a-z0-9_-]+)(?:\/(start|poll)(?:\/([a-zA-Z0-9_-]+))?)?$/.exec(route);
    if (account) {
      const name = identifier(account[1]);
      if (account[2] === 'start' && !account[3] && method === 'POST') {
        const value = await input(['confirm']); if (value.confirm !== true) throw invalid('Confirm starting this provider sign-in.');
        const catalog = await dashboard('/api/providers/oauth');
        if (!catalog.providers?.some(item => item.id === account[1] && item.flow === 'device_code')) throw invalid('This provider requires its own external sign-in; native dashboard login is unavailable.');
        const result = await dashboard(`/api/providers/oauth/${name}/start`, { method });
        return json(res, 200, project(result, ['session_id', 'flow', 'user_code', 'verification_url', 'expires_in', 'poll_interval']));
      }
      if (account[2] === 'poll' && account[3] && method === 'GET') {
        const result = await dashboard(`/api/providers/oauth/${name}/poll/${identifier(account[3])}`);
        return json(res, 200, project(result, ['session_id', 'status', 'expires_at', 'retryable', 'retry_after', 'model']));
      }
      if (!account[2] && method === 'DELETE') {
        const value = await input(['confirm']); if (value.confirm !== true) throw invalid('Confirm disconnecting this account for the selected bot.');
        return json(res, 200, await dashboard(`/api/providers/oauth/${name}`, { method }));
      }
    }
    const cancel = /^accounts\/sessions\/([a-zA-Z0-9_-]+)$/.exec(route);
    if (cancel && method === 'DELETE') return json(res, 200, await dashboard(`/api/providers/oauth/sessions/${identifier(cancel[1])}`, { method }));
    throw new HermesError(404, 'Unknown Hermes setup operation.', 'NOT_FOUND');
  };
}
