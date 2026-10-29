import path from 'node:path';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { HermesError, hermesProfile, hermesResource, parseHermesSessionKey } from './hermes-client.mjs';
import { scheduleProblem } from './schedule-input.mjs';
import { readObservedFile } from './bounded-file.mjs';

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
export function createHermesWorkspaceRoutes({ client, bridge, workspaceRoot, bots, submitAutomation, artifacts }) {
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
    const validateSchedule = async (schedule, after) => {
      const problem = scheduleProblem(schedule); if (problem) throw invalid(problem);
      if (after !== undefined && (typeof after !== 'string' || after.length > 40 || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(after) || !Number.isFinite(Date.parse(after)))) throw invalid('Use an ISO preview reference with an explicit UTC offset.');
      const result = await dashboard('/api/hob/schedule-preview', { method: 'POST', body: { schedule, ...(after !== undefined ? { after } : {}) } });
      if (result?.valid !== true || typeof result.nextRun !== 'string' || !Number.isFinite(Date.parse(result.nextRun)) || (after !== undefined && Date.parse(result.nextRun) <= Date.parse(after))) throw invalid('Hermes could not validate a future run for this schedule.');
      return result;
    };
    if (route === 'schedule-preview' && method === 'POST') {
      const value = await input(['schedule', 'after']);
      return json(res, 200, await validateSchedule(value.schedule, value.after));
    }
    const review = /^reviews\/(memory|skills)(?:\/([a-zA-Z0-9_-]{1,128}))?$/.exec(route);
    if (review) {
      if (method === 'GET') {
        const offset = url.searchParams.get('offset') || '0';
        if (!/^\d{1,5}$/.test(offset) || Number(offset) > 10000) throw invalid('Invalid proposal page.');
        return json(res, 200, await dashboard(`/api/hob/reviews/${review[1]}${review[2] ? `/${review[2]}` : ''}`, { query: { offset } }));
      }
      if (method === 'POST' && !review[2]) {
        const value = await input(['id', 'revision', 'action', 'requestId', 'confirm']);
        if (value.confirm !== true || !['approve', 'reject'].includes(value.action) || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id || '') || value.id === 'all'
          || !/^[a-f0-9]{64}$/.test(value.revision || '') || !/^[a-zA-Z0-9_-]{16,128}$/.test(value.requestId || '')) throw invalid('Confirm one exact proposal revision.');
        return json(res, 200, await dashboard(`/api/hob/reviews/${review[1]}`, { method, body: value }));
      }
    }
    if (route === 'review-history' && method === 'GET') return json(res, 200, await dashboard('/api/hob/review-history'));

    if (route === 'autonomy' && ['GET', 'POST'].includes(method)) {
      if (!bridge) throw new HermesError(503, 'The native session connection is unavailable.', 'SESSION_UNAVAILABLE');
      const value = method === 'POST' ? await input(['sessionKey', 'kind', 'action', 'prompt', 'intervalSeconds']) : { sessionKey: url.searchParams.get('sessionKey') };
      const owner = parseHermesSessionKey(value.sessionKey);
      if (owner.profile !== profile || owner.transport !== 'canonical') throw invalid('Choose a native conversation belonging to this bot.');
      const params = { session_id: owner.sessionId };
      // Resume the existing route through its owner; never manufacture another
      // conversation or read/write the runtime's SQLite file from this process.
      await bridge.rpc(profile, 'session.resume', params);
      let dispatch;
      if (method === 'POST') {
        if (!['heartbeat', 'goal'].includes(value.kind) || !['set', 'pause', 'resume', 'clear'].includes(value.action)) throw invalid('Choose a valid autonomy action.');
        if (value.action === 'set') {
          const prompt = text(value.prompt, 'recurring instruction or goal', 4000).trim();
          // This form sets a free-form outcome. Keep multiline instructions
          // literal rather than interpreting a line as a native contract field.
          let arg = `-- ${prompt.replace(/\s+/g, ' ')}`;
          if (value.kind === 'heartbeat') {
            if (!Number.isSafeInteger(value.intervalSeconds) || value.intervalSeconds < 60 || value.intervalSeconds > 604800) throw invalid('Heartbeat intervals must be between one minute and seven days.');
            arg = `every ${value.intervalSeconds}s ${prompt}`;
          }
          dispatch = await bridge.rpc(profile, 'command.dispatch', { ...params, name: value.kind, arg });
        } else {
          dispatch = await bridge.rpc(profile, 'session.control', { ...params, action: `${value.kind}.${value.action}`, args: {} });
        }
      }
      const result = await bridge.rpc(profile, 'session.control.read', params);
      if (!result?.control || typeof result.control.revision !== 'string') throw new HermesError(502, 'Hermes returned an invalid automation snapshot.', 'HERMES_PROTOCOL_ERROR');
      if (value.action === 'set') {
        const state = result.control[value.kind];
        if (state?.status !== 'active' || (value.kind === 'goal' && state.title !== value.prompt.trim().replace(/\s+/g, ' ')) || (value.kind === 'heartbeat' && (state.prompt !== value.prompt.trim() || state.interval_seconds !== value.intervalSeconds))) {
          throw new HermesError(409, 'Hermes did not activate these instructions. Refresh to inspect the current state.', 'AUTOMATION_NOT_CONFIRMED');
        }
      }
      const directive = dispatch?.dispatch || dispatch;
      let admission;
      if (directive?.type === 'send') {
        if (!submitAutomation) throw new HermesError(503, 'Native goal admission is unavailable. The goal setting may already have changed.', 'SESSION_UNAVAILABLE');
        admission = await submitAutomation(value.sessionKey, directive.message);
      }
      return json(res, 200, { control: result.control, ...(admission ? { admissionId: admission.admission_id } : {}), ...(typeof directive?.output === 'string' ? { output: directive.output } : {}) });
    }

    if (route === 'jobs' && method === 'GET') return json(res, 200, await dashboard('/api/cron/jobs'));
    if (route === 'jobs' && method === 'POST') {
      const value = await input(['name', 'prompt', 'schedule', 'paused']);
      text(value.name, 'task name', 200); text(value.prompt, 'task instructions'); text(value.schedule, 'schedule', 200);
      await validateSchedule(value.schedule);
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
      if (value?.schedule) await validateSchedule(value.schedule);
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
      if (['approve', 'reject'].includes(value.action)) throw new HermesError(409, 'Inspect the complete proposal in the versioned review queue before deciding.', 'VERSIONED_REVIEW_REQUIRED');
      if (!bridge) throw new HermesError(503, 'Hermes native sessions are unavailable.', 'SESSION_UNAVAILABLE');
      const result = await bridge.rpc(profile, 'command.dispatch', { session_id: owner.sessionId, name: 'skills', arg: value.action + (value.action === 'pending' ? '' : ` ${value.id}`) });
      if (result?.type !== 'exec' || typeof result.output !== 'string') throw new HermesError(502, 'Hermes did not return a skill review result. Refresh before retrying.', 'HERMES_PROTOCOL_ERROR');
      return json(res, 200, { output: result.output });
    }

    if (['files', 'file', 'download'].includes(route) && method === 'GET') {
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
        return json(res, 200, { path: path.relative(root, target).split(path.sep).join('/'), entries, ...(artifacts ? { deliveries: await artifacts.list(profile) } : {}) });
      }
      const info = await lstat(target);
      if (route === 'download') {
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 25 * 1024 * 1024) throw invalid('Downloads support independent files up to 25 MB.');
        const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
          const current = await handle.stat();
          if (!current.isFile() || current.nlink !== 1 || current.ino !== info.ino || current.dev !== info.dev || current.size !== info.size) throw invalid('File changed before download. Refresh and try again.');
          await client.credentialBinding(profile);
          const bytes = await readObservedFile(handle, info.size);
          const after = await handle.stat();
          if (bytes.length !== info.size || after.mtimeMs !== current.mtimeMs || after.size !== current.size) throw invalid('File changed during download. Refresh and try again.');
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.basename(target).replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
            'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
          res.end(bytes); return;
        } finally { await handle.close(); }
      }
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw invalid('Preview supports regular files up to 2 MB.');
      const result = await dashboard('/api/files/read', { query: { path: target } });
      return json(res, 200, { name: result.name, path: relative, mimeType: result.mime_type, dataUrl: result.data_url, size: result.size });
    }
    throw new HermesError(404, 'Unknown Hermes workspace operation.', 'NOT_FOUND');
  };
}
