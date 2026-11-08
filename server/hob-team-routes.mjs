import { HOB_OPERATOR } from './hob-team-orchestrator.mjs';
import { HermesError } from './hermes-client.mjs';

// Dashboard authentication/origin checks happen in app.mjs; bot authentication
// happens in the relay. Never accept an actor or approval flag from the body.
export async function hobTeamRoute(memory, actor, req, res, resource, url, { body, json }) {
  if (!memory) throw new HermesError(503, 'HOB team memory is unavailable.', 'HOB_TEAM_UNAVAILABLE');
  const options = {};
  for (const key of ['before', 'limit']) if (url.searchParams.has(key)) options[key] = Number(url.searchParams.get(key));
  if (req.method === 'GET') {
    const output = /^\/output\/([A-Za-z0-9_-]{1,64})$/.exec(resource);
    if (output) {
      const file = await memory.output(actor, output[1]);
      const filename = encodeURIComponent(file.name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.bytes.length, 'Content-Disposition': `attachment; filename*=UTF-8''${filename}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(file.bytes); return;
    }
    if (!resource) return json(res, 200, memory.status(actor));
    if (['/tasks', '/followups', '/candidates'].includes(resource)) return json(res, 200, { items: memory.list(actor, resource.slice(1), options) });
    if (resource === '/episodes') return json(res, 200, { items: memory.episodes(actor === HOB_OPERATOR ? url.searchParams.get('profile') || 'default' : actor, options) });
    if (resource === '/inbox') return json(res, 200, { items: memory.inbox(actor === HOB_OPERATOR ? url.searchParams.get('profile') || 'default' : actor, options.before) });
    if (resource === '/audit' && actor === HOB_OPERATOR) return json(res, 200, { items: memory.audit() });
  }
  if (req.method === 'POST') {
    if (!memory.enabled() && resource !== '/inbox/read') throw new HermesError(409, 'Enable HOB team architecture in team settings first.', 'HOB_TEAM_DISABLED');
    const input = await body(req);
    const methods = { '/plan': 'plan', '/progress': 'progress', '/followups': 'followup', '/followups/decide': 'decideFollowup', '/preferences': 'configure', '/remember': 'remember', '/candidates': 'candidate', '/candidates/decide': 'decideCandidate', '/text-review': 'reviewText', '/inbox/read': 'acknowledge' };
    if (methods[resource]) {
      const result = await memory[methods[resource]](actor, input);
      await memory.sweep();
      return json(res, 200, result);
    }
    if (resource === '/sweep' && actor === HOB_OPERATOR && input?.confirm === true && Object.keys(input).length === 1) {
      await memory.sweep(); return json(res, 200, memory.status(actor));
    }
  }
  throw new HermesError(404, 'Unknown HOB team-memory action.', 'NOT_FOUND');
}
