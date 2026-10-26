import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { HermesError, hermesProfile, hermesResource, parseHermesSessionKey } from './hermes-client.mjs';

const invalid = message => new HermesError(400, message, 'INVALID_REQUEST');
const text = (value, label, max = 64000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`Enter a valid ${label}.`);
  return value;
};
const only = (value, fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw invalid('Unsupported operation fields.');
  return value;
};
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
const sensitive = /(?:^|[\\/])(?:\.[^\\/]*|node_modules|credentials?|secrets?)(?:[\\/]|$)|(?:token|credential|secret|\.pem$|\.key$)/i;

/** Custom dashboard operations use native Hermes owners, never OpenClaw RPC. */
export function createHermesWorkspaceRoutes({ client, bridge, workspaceRoot, bots }) {
  return async (req, res, url, { json, body }) => {
    const route = url.pathname.slice('/api/hermes/workspace/'.length);
    const method = req.method;
    const selected = url.searchParams.getAll('profile');
    if (selected.length > 1) throw invalid('Select one bot.');
    const profile = hermesProfile(selected[0] ?? req.headers['x-hob-profile'] ?? 'default');
    if (profile === 'all') throw invalid('Select one bot, not all profiles.');
    // Even list/read operations must be bound to an enrolled, active bot.
    await client.credentialBinding(profile);
    const dashboard = (pathname, options = {}) => client.dashboard(pathname, { ...options, profile });
    const input = async fields => {
      const value = only(await body(req), [...fields, 'profile']);
      if ('profile' in value && value.profile !== profile) throw invalid('The selected bot does not match the request.');
      const { profile: _profile, ...result } = value;
      return result;
    };

    if (route === 'jobs' && method === 'GET') return json(res, 200, await dashboard('/api/cron/jobs'));
    if (route === 'jobs' && method === 'POST') {
      const value = await input(['name', 'prompt', 'schedule', 'paused']);
      text(value.name, 'task name', 200); text(value.prompt, 'task instructions'); text(value.schedule, 'schedule', 200);
      if ('paused' in value && typeof value.paused !== 'boolean') throw invalid('Paused must be a boolean.');
      return json(res, 201, await dashboard('/api/cron/jobs', { method, body: { ...value, deliver: 'local' } }));
    }
    const job = /^jobs\/([^/]+)(?:\/(pause|resume|trigger|runs))?$/.exec(route);
    if (job && ((!job[2] && ['GET', 'PUT', 'DELETE'].includes(method)) || (job[2] === 'runs' ? method === 'GET' : job[2] && method === 'POST'))) {
      let id;
      try { id = decodeURIComponent(job[1]); hermesResource(id); } catch { throw invalid('Invalid task identifier.'); }
      // Hermes's desktop API can discover an owner in OTHER profiles when a
      // supplied hint has no matching job. Do not let arbitrary IDs invoke it.
      const jobs = await dashboard('/api/cron/jobs');
      if (!Array.isArray(jobs)) throw new HermesError(502, 'Hermes returned an invalid task list.', 'HERMES_PROTOCOL_ERROR');
      if (!jobs.some(item => item.id === id)) throw new HermesError(404, 'This task does not belong to the selected bot.', 'NOT_FOUND');
      const value = method === 'PUT' ? await input(['name', 'prompt', 'schedule']) : undefined;
      if (value) for (const [key, entry] of Object.entries(value)) text(entry, key, key === 'prompt' ? 64000 : 200);
      return json(res, 200, await dashboard(`/api/cron/jobs/${hermesResource(id)}${job[2] ? `/${job[2]}` : ''}`,
        { method, ...(value ? { body: { updates: value } } : {}) }));
    }

    const reads = new Map([['skills', '/api/skills'], ['learning', '/api/learning/graph'], ['memory', '/api/memory'], ['toolsets', '/api/tools/toolsets']]);
    if (reads.has(route) && method === 'GET') return json(res, 200, await dashboard(reads.get(route)));
    if (route === 'skill' && method === 'GET') return json(res, 200, await dashboard('/api/skills/content', { query: { name: text(url.searchParams.get('name'), 'skill name', 256) } }));
    if (route === 'skill' && ['POST', 'PUT'].includes(method)) {
      const value = await input(['name', 'content']); text(value.name, 'skill name', 256); text(value.content, 'skill content', 512000);
      // Foreground dashboard edits are explicit human writes, not agent proposals.
      return json(res, method === 'POST' ? 201 : 200, await dashboard(method === 'POST' ? '/api/skills' : '/api/skills/content', { method, body: { ...value, profile } }));
    }
    if (route === 'skill/toggle' && method === 'PUT') {
      const value = await input(['name', 'enabled']); text(value.name, 'skill name', 256);
      if (typeof value.enabled !== 'boolean') throw invalid('Enabled must be a boolean.');
      return json(res, 200, await dashboard('/api/skills/toggle', { method, body: { ...value, profile } }));
    }
    if (route === 'learning/node' && ['GET', 'PUT', 'DELETE'].includes(method)) {
      const value = method === 'GET' ? { id: text(url.searchParams.get('id'), 'memory identifier', 512) } : await input(['id', 'content']);
      text(value.id, 'memory identifier', 512);
      if (!/^memory:(memory|profile):\d+:[a-f0-9]{12}$/.test(value.id)) throw invalid('Refresh memory to obtain a current entry identifier.');
      if (method === 'PUT') text(value.content, 'memory content');
      return json(res, 200, await dashboard('/api/learning/node', { method,
        ...(method === 'GET' ? { query: value } : { body: { ...value, profile } }) }));
    }
    if (route === 'soul' && ['GET', 'PUT'].includes(method)) {
      const value = method === 'PUT' ? await input(['content']) : undefined;
      if (value && (typeof value.content !== 'string' || value.content.length > 64000)) throw invalid('Soul content must be text under 64,000 characters.');
      if (method === 'PUT' && bots?.saveSoul) return json(res, 200, await bots.saveSoul(profile, value.content));
      return json(res, 200, await dashboard(`/api/profiles/${profile}/soul`, { method, ...(value ? { body: value } : {}) }));
    }
    if (route === 'skill-review' && method === 'POST') {
      const value = await input(['sessionKey', 'action', 'id', 'confirm']);
      let owner; try { owner = parseHermesSessionKey(value.sessionKey); } catch { throw invalid('Select a native Hermes conversation for this bot.'); }
      if (owner.profile !== profile || owner.transport !== 'canonical') throw invalid('Select a native Hermes conversation for this bot.');
      if (!['pending', 'diff', 'approve', 'reject'].includes(value.action)) throw invalid('Unsupported skill review operation.');
      if (value.action !== 'pending' && (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id) || value.id === 'all')) throw invalid('Select one pending proposal identifier.');
      if (['approve', 'reject'].includes(value.action) && value.confirm !== true) throw invalid('Confirm the proposal decision.');
      if (!bridge) throw new HermesError(503, 'Hermes native sessions are unavailable.', 'SESSION_UNAVAILABLE');
      const result = await bridge.rpc(profile, 'command.dispatch', { session_id: owner.sessionId, name: 'skills', arg: value.action + (value.action === 'pending' ? '' : ` ${value.id}`) });
      if (result?.type !== 'exec' || typeof result.output !== 'string') throw new HermesError(502, 'Hermes did not return a skill review result. Refresh before retrying.', 'HERMES_PROTOCOL_ERROR');
      return json(res, 200, { output: result.output });
    }

    if (['files', 'file'].includes(route) && method === 'GET') {
      if (!workspaceRoot) throw new HermesError(503, 'The dashboard workspace has not been configured.', 'WORKSPACE_UNAVAILABLE');
      // Canonicalize the trusted deployment root first. Windows packaged apps
      // may present the same LocalAppData directory under a redirected spelling.
      // Bot roots below it must still resolve to their exact assigned directory.
      let ownedRoot;
      try { ownedRoot = await realpath(workspaceRoot); }
      catch (error) { if (error.code === 'ENOENT') throw new HermesError(404, 'Bot workspace does not exist.', 'NOT_FOUND'); throw error; }
      const base = path.resolve(ownedRoot, profile === 'default' ? 'main' : path.join('bots', profile));
      const relative = url.searchParams.get('path') || '';
      if (relative.length > 4096 || /[\x00-\x1f%:]/.test(relative) || path.isAbsolute(relative) || sensitive.test(relative)) throw invalid('Select a non-sensitive file inside this bot’s workspace.');
      const candidate = path.resolve(base, relative);
      if (!within(base, candidate)) throw invalid('Path is outside this bot’s workspace.');
      let root, target;
      try { root = await realpath(base); target = await realpath(candidate); }
      catch (error) { if (error.code === 'ENOENT') throw new HermesError(404, 'Workspace path does not exist.', 'NOT_FOUND'); throw error; }
      if (root !== base || !within(root, target) || sensitive.test(path.relative(root, target))) throw invalid('Linked or sensitive paths outside this workspace are unavailable.');
      if (route === 'files') {
        const listing = await dashboard('/api/files', { query: { path: target } });
        if (!Array.isArray(listing.entries)) throw new HermesError(502, 'Hermes returned an invalid directory.', 'HERMES_PROTOCOL_ERROR');
        const entries = listing.entries.filter(item => typeof item.path === 'string' && path.isAbsolute(item.path) && within(root, item.path)
          && !sensitive.test(path.relative(root, item.path)) && !item.broken_link)
          .map(item => ({ name: item.name, path: path.relative(root, item.path).split(path.sep).join('/'), directory: item.is_directory === true, size: item.size }));
        return json(res, 200, { path: path.relative(root, target).split(path.sep).join('/'), entries });
      }
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw invalid('Preview supports regular files up to 2 MB.');
      const result = await dashboard('/api/files/read', { query: { path: target } });
      return json(res, 200, { name: result.name, path: relative, mimeType: result.mime_type, dataUrl: result.data_url, size: result.size });
    }
    throw new HermesError(404, 'Unknown Hermes workspace operation.', 'NOT_FOUND');
  };
}
