import nodePath from 'node:path';
import { HermesError, hermesProfile, hermesResource } from './hermes-client.mjs';
import { containsStoredSecret, redactHermesSettings } from './hermes-settings.mjs';
import { clearAvatar, readAvatar, setAvatar, streamAvatar } from './hermes-avatars.mjs';
import { serveHermesMedia } from './hermes-media.mjs';

// Explicit public operations, rather than an arbitrary upstream-URL proxy.
const MANAGEMENT = new Map([
  ['GET config', '/api/config'], ['PUT config', '/api/config'],
  ['GET config/schema', '/api/config/schema'], ['GET config/defaults', '/api/config/defaults'],
  ['GET credentials', '/api/env'], ['PUT credentials', '/api/env'],
  ['GET models', '/api/model/options'], ['GET model', '/api/model/info'],
  ['POST model', '/api/model/set'], ['GET skills', '/api/skills'],
  ['GET custom-endpoints', '/api/providers/custom-endpoints'], ['POST custom-endpoints', '/api/providers/custom-endpoints'],
]);
export const MANAGED_ENV = /^(?:BROWSER_CDP_URL$|BU_CDP_(?:URL|WS)$|API_SERVER_|MUSE_|HOB_|GATEWAY_MULTIPLEX_PROFILES$|HERMES_API_KEY$|HERMES_DASHBOARD_|HERMES_GATEWAY_|HERMES_(?:HOME|DIR|EXECUTABLE|INSTALL_ROOT|PYTHON|RUNTIME_DIR)$|PATH$|PYTHONPATH$|LD_|NODE_OPTIONS$)/;

function resourceId(encoded) {
  try { const value = decodeURIComponent(encoded); hermesResource(value); return value; }
  catch { throw new HermesError(400, 'Invalid Hermes resource identifier.', 'INVALID_RESOURCE'); }
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HermesError(400, 'A JSON object is required.', 'INVALID_REQUEST');
  }
  return value;
}

export function createHermesRoutes(client, bots, { removeBot, home, stateDir } = {}) {
  return async (req, res, url, { json, body, startEvents, sendEvent }) => {
    const method = req.method;
    const path = url.pathname.slice('/api/hermes/'.length);
    const profiles = url.searchParams.getAll('profile');
    if (profiles.length > 1) throw new HermesError(400, 'Select one profile.', 'INVALID_PROFILE');
    const profile = hermesProfile(profiles[0] ?? 'default');
    const options = { profile, method };

    if (path === 'media' && ['GET', 'HEAD'].includes(method)) {
      if (bots && !bots.has(profile)) throw new HermesError(404, 'This bot no longer exists.', 'BOT_NOT_FOUND');
      const values = url.searchParams.getAll('path');
      if (values.length !== 1) throw new HermesError(400, 'Select one media path.', 'INVALID_REQUEST');
      return await serveHermesMedia(req, res, {
        home,
        workspaces: home ? nodePath.join(home, 'workspaces') : undefined,
        stateDir,
        profile,
        value: values[0],
      });
    }
    if (path === 'capabilities' && method === 'GET') {
      return json(res, 200, await client.runtime('/v1/capabilities', options));
    }
    if (path === 'profiles' && method === 'GET') {
      return json(res, 200, await (bots ? bots.list() : client.dashboard('/api/profiles')));
    }
    if (path === 'profiles' && method === 'POST') {
      const input = object(await body(req));
      // New bots start with independent state. Cloning private memory or channel
      // credentials needs its own explicit UX, never an implicit default.
      const proposal = { name: hermesProfile(input.name) };
      if (proposal.name === 'default') throw new HermesError(400, 'The Main profile already exists.', 'INVALID_PROFILE');
      if (input.displayName !== undefined && (typeof input.displayName !== 'string' || input.displayName.length > 64)) {
        throw new HermesError(400, 'Enter a display name under 64 characters.', 'INVALID_REQUEST');
      }
      for (const key of ['soul', 'description', 'provider', 'model']) {
        if (input[key] !== undefined) {
          if (typeof input[key] !== 'string' || input[key].length > 64000) {
            throw new HermesError(400, `Invalid ${key}.`, 'INVALID_REQUEST');
          }
          proposal[key] = input[key];
        }
      }
      if (input.displayName !== undefined) proposal.displayName = input.displayName;
      if (input.tags !== undefined) proposal.tags = input.tags;
      if (Object.keys(input).some(key => !['name', 'displayName', 'tags', 'soul', 'description', 'provider', 'model'].includes(key))) {
        throw new HermesError(400, 'Unsupported bot creation option.', 'INVALID_REQUEST');
      }
      return json(res, 201, await (bots ? bots.create(proposal) : client.dashboard('/api/profiles', { method, body: proposal })));
    }
    const finish = /^profiles\/([a-z][a-z0-9_-]{0,63})\/finish-setup$/.exec(path);
    if (finish && method === 'POST' && bots) {
      const input = object(await body(req));
      if (Object.keys(input).some(key => key !== 'confirmExisting') || ('confirmExisting' in input && typeof input.confirmExisting !== 'boolean')) {
        throw new HermesError(400, 'Invalid bot setup confirmation.', 'INVALID_REQUEST');
      }
      return json(res, 200, await bots.finishSetup(hermesProfile(finish[1]), input));
    }
    const avatar = /^profiles\/([a-z][a-z0-9_-]{0,63})\/avatar(?:\/(image))?$/.exec(path);
    if (avatar) {
      if (!home) throw new HermesError(503, 'The native profile home is unavailable.', 'AVATAR_UNAVAILABLE');
      const name = hermesProfile(avatar[1]);
      if (avatar[2] === 'image') {
        if (method !== 'GET') throw new HermesError(404, 'Unknown Hermes application endpoint.', 'NOT_FOUND');
        const found = await readAvatar(home, name);
        if (!found) throw new HermesError(404, 'This bot has no avatar.', 'AVATAR_NOT_FOUND');
        return await streamAvatar(res, found);
      }
      if (method === 'GET') {
        const found = await readAvatar(home, name);
        return json(res, 200, found
          ? { found: true, mime: found.mime, size: found.size }
          : { found: false });
      }
      if (method === 'PUT' || method === 'POST') {
        const input = object(await body(req));
        if (Object.keys(input).some(key => key !== 'data')) throw new HermesError(400, 'Unsupported avatar option.', 'INVALID_REQUEST');
        return json(res, 200, await setAvatar(home, name, input.data));
      }
      if (method === 'DELETE') return json(res, 200, await clearAvatar(home, name));
    }
    const profileMatch = /^profiles\/([a-z][a-z0-9_-]{0,63})(?:\/(soul|description|model))?$/.exec(path);
    if (profileMatch) {
      const name = hermesProfile(profileMatch[1]);
      const resource = profileMatch[2];
      if (!resource && method === 'PATCH' && bots) {
        const input = object(await body(req));
        if (!Object.keys(input).length || Object.keys(input).some(key => !['displayName', 'tags', 'description'].includes(key))) {
          throw new HermesError(400, 'Only name, labels and role can be changed here.', 'INVALID_REQUEST');
        }
        return json(res, 200, await bots.updateIdentity(name, input));
      }
      if (!resource && method === 'DELETE') {
        if (name === 'default') throw new HermesError(400, 'The Main bot cannot be deleted.', 'INVALID_PROFILE');
        const remove = () => bots ? bots.remove(name) : client.dashboard(`/api/profiles/${name}`, { method });
        return json(res, 200, await (removeBot ? removeBot(name, remove) : remove()));
      }
      if (resource && ((method === 'GET' && resource === 'soul') || method === 'PUT')) {
        const input = method === 'GET' ? undefined : object(await body(req));
        if (bots && resource === 'soul' && method === 'PUT') {
          if (typeof input.content !== 'string') throw new HermesError(400, 'Soul content must be text.', 'INVALID_REQUEST');
          return json(res, 200, await bots.saveSoul(name, input.content));
        }
        if (bots && resource === 'description' && method === 'PUT') return json(res, 200, await bots.updateIdentity(name, { description: input.description }));
        return json(res, 200, await client.dashboard(`/api/profiles/${name}/${resource}`, { profile: name, method, body: input }));
      }
    }

    const upstream = MANAGEMENT.get(`${method} ${path}`);
    if (upstream) {
      let input;
      if (method !== 'GET') {
        input = object(await body(req));
        if ('profile' in input && input.profile !== profile) {
          throw new HermesError(400, 'The selected profile does not match the request.', 'INVALID_PROFILE');
        }
        // ConfigUpdate / EnvVarUpdate accept a body profile which takes
        // precedence upstream. Bind both selectors to the same owner here.
        input = { ...input, profile };
        if (path === 'credentials') {
          if (typeof input.key !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(input.key)
            || MANAGED_ENV.test(input.key) || typeof input.value !== 'string' || !input.value.trim()) {
            throw new HermesError(400, 'Enter a provider/tool credential, not a managed deployment variable.', 'INVALID_REQUEST');
          }
        }
        if (path === 'config') {
          object(input.config);
          if (containsStoredSecret(input.config)) {
            throw new HermesError(400, 'Stored credential placeholders cannot be saved. Submit only changed settings.', 'INVALID_REQUEST');
          }
        }
        if (path === 'custom-endpoints') {
          if (input.make_default === true || containsStoredSecret(input)) {
            throw new HermesError(400, 'Save the endpoint first, then explicitly select its model.', 'INVALID_REQUEST');
          }
          input.make_default = false;
        }
      }
      const result = await client.dashboard(upstream, { ...options, body: input });
      return json(res, 200, ['config', 'custom-endpoints'].includes(path) ? redactHermesSettings(result) : result);
    }

    if (path === 'sessions' && ['GET', 'POST'].includes(method)) {
      return json(res, method === 'POST' ? 201 : 200, await client.runtime('/api/sessions', {
        ...options, ...(method === 'POST' ? { body: object(await body(req)) } : {}),
      }));
    }
    const session = /^sessions\/([^/]+)(?:\/(messages|fork|model))?$/.exec(path);
    if (session) {
      const allowed = session[2] === 'messages' ? method === 'GET'
        : session[2] ? method === 'POST' : ['GET', 'PATCH', 'DELETE'].includes(method);
      if (allowed) {
        const suffix = session[2] ? `/${session[2]}` : '';
        const pathname = `/api/sessions/${hermesResource(resourceId(session[1]))}${suffix}`;
        return json(res, 200, await client.runtime(pathname, {
          ...options, ...(['POST', 'PATCH'].includes(method) ? { body: object(await body(req)) } : {}),
        }));
      }
    }
    if (path === 'runs' && method === 'POST') {
      const input = object(await body(req));
      return json(res, 202, await client.runtime('/v1/runs', {
        ...options, body: input, idempotencyKey: req.headers['idempotency-key'],
      }));
    }
    const run = /^runs\/([^/]+)(?:\/(events|approval|clarify|steer|stop))?$/.exec(path);
    if (run) {
      const runId = resourceId(run[1]);
      if (run[2] === 'events' && method === 'GET') {
        const controller = new AbortController();
        const close = () => controller.abort();
        res.once('close', close);
        startEvents(res);
        try {
          for await (const event of client.events(runId, { profile, signal: controller.signal })) {
            if (res.destroyed) break;
            sendEvent(res, 'hermes', event);
          }
        } finally {
          res.off('close', close);
          res.end();
        }
        return;
      }
      if ((!run[2] && method === 'GET') || (['approval', 'clarify', 'steer', 'stop'].includes(run[2]) && method === 'POST')) {
        return json(res, 200, await client.runtime(`/v1/runs/${hermesResource(runId)}${run[2] ? `/${run[2]}` : ''}`, {
          ...options, ...(method === 'POST' ? { body: object(await body(req)) } : {}),
        }));
      }
    }
    throw new HermesError(404, 'Unknown Hermes application endpoint.', 'NOT_FOUND');
  };
}
