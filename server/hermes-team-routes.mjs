import { HermesError } from './hermes-client.mjs';

// Called only after the dashboard session gate. Bot relay credentials never reach decisions.
export function createHermesTeamRoutes({ team, bots }) {
  return async (req, res, url, { body, json }) => {
    const resource = url.pathname.slice('/api/hermes/team'.length);
    if (!resource && req.method === 'GET') return json(res, 200, team.status());
    if (resource === '/history' && req.method === 'GET') return json(res, 200, { revisions: team.history() });
    if (resource === '/draft' && req.method === 'GET') return json(res, 200, { content: await team.draft(), base: team.core().revision });
    const value = req.method === 'POST' || req.method === 'PUT' ? await body(req) : null;
    if (value && (typeof value !== 'object' || Array.isArray(value))) throw new HermesError(400, 'Use a team request object.', 'INVALID_TEAM_REQUEST');
    if (resource === '/settings' && req.method === 'PUT') {
      team.configure(value || {});
      const sync = await bots.syncSharedNetwork();
      return json(res, 200, { ...team.status(), sync });
    }
    if (resource === '/proposals' && req.method === 'POST') {
      if (!value || Object.keys(value).some(key => !['content', 'base', 'evidence'].includes(key))) throw new HermesError(400, 'Unsupported proposal fields.', 'INVALID_TEAM_REQUEST');
      return json(res, 201, team.propose({ ...value, author: 'user' }));
    }
    if (resource === '/decisions' && req.method === 'POST') {
      if (!value || Object.keys(value).some(key => !['id', 'base', 'digest', 'decision', 'confirm'].includes(key))) throw new HermesError(400, 'Unsupported decision fields.', 'INVALID_TEAM_REQUEST');
      team.decide(value);
      const sync = await bots.syncSharedNetwork();
      return json(res, 200, { ...team.status(), sync });
    }
    if (resource === '/sync' && req.method === 'POST' && value?.confirm === true && Object.keys(value).length === 1) {
      await team.discoverDraft();
      const sync = await bots.syncSharedNetwork();
      return json(res, 200, { ...team.status(), sync });
    }
    throw new HermesError(400, 'Unknown or unconfirmed employee-team action.', 'INVALID_TEAM_REQUEST');
  };
}
