// Owned loopback fixture for the smoke tiers. Never a production provider.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMcpOAuthFixture } from './smoke-mcp.mjs';

export const SMOKE_MODEL = 'hob-container-smoke';
export const SMOKE_PROMPT = 'HOB_CONTAINER_SMOKE_WRITE';
export const SMOKE_REPLY = 'HOB_CONTAINER_SMOKE_OK';
export const SMOKE_ATTACHMENT_PROMPT = 'HOB_NATIVE_ATTACHMENT_PROOF';
export const SMOKE_ATTACHMENT_REPLY = 'HOB_NATIVE_IMAGE_RECEIVED';
export const SMOKE_FILE = 'container-smoke-proof.txt';
export const SMOKE_CONTENT = 'Hermes executed the isolated container smoke tool.\n';
export const SMOKE_SCHEDULE_PROMPT = 'HOB_PROACTIVE_SCHEDULE_PROOF';
export const SMOKE_SCHEDULE_REPLY = 'HOB_PROACTIVE_SCHEDULE_FINISHED';
export const SMOKE_RELAY_PROMPT = 'HOB_PROACTIVE_SMOKE_RELAY';
export const SMOKE_RELAY_REPLY = 'HOB_PROACTIVE_RELAY_SENT';
export const SMOKE_WORKER_PROMPT = 'HOB_PROACTIVE_WORKER_REQUEST';
export const SMOKE_WORKER_ID = 'proactive-worker';
export const SMOKE_WORKER_REPLY = 'HOB_PROACTIVE_WORKER_DONE';
export const SMOKE_WAKE_REPLY = 'HOB_PROACTIVE_COORDINATOR_RESUMED';
export const SMOKE_HEARTBEAT_PROMPT = 'HOB_PROACTIVE_HEARTBEAT_CHECK';
export const SMOKE_HEARTBEAT_REPLY = 'HOB_PROACTIVE_HEARTBEAT_DONE';
export const SMOKE_RECOVERY_PROMPT = 'HOB_CRASH_RECOVERY_HOLD';
export const SMOKE_RECOVERY_REPLY = 'HOB_CRASH_RECOVERY_HELD_REPLY';
export const SMOKE_RECOVERY_RESUME = 'HOB_CRASH_RECOVERY_REVIEWED_RESUME';
export const SMOKE_SKILL_PROMPT = 'HOB_CONTAINER_SMOKE_SKILL';
export const SMOKE_SKILL_REPLY = 'HOB_CONTAINER_SKILL_STAGED';
export const SMOKE_SKILL_NAME = 'hob-smoke-lesson';
export const SMOKE_SKILL_CONTENT = '---\nname: hob-smoke-lesson\ndescription: Use when validating an isolated staged learning workflow.\n---\n\n# Isolated verification lesson\n\nRequire explicit review before activating this synthetic skill.\n';

// The artifact path is injectable so a container run can name the bot workspace
// explicitly instead of depending on the runtime working directory.
const defaultFile = () => process.env.HOB_SMOKE_FILE || SMOKE_FILE;

function completion(res, input, message) {
  if (res.destroyed || res.writableEnded) return;
  const finish = message.tool_calls ? 'tool_calls' : 'stop';
  if (input.stream === true) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'hob-smoke', object: 'chat.completion.chunk', model: SMOKE_MODEL, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    res.write(chunk(message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((item, index) => ({ index, ...item })) } : message, null));
    res.write(chunk({}, finish)); return res.end('data: [DONE]\n\n');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'hob-smoke', object: 'chat.completion', model: SMOKE_MODEL,
    choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
}

export function createSmokeModel({ file = defaultFile() } = {}) {
  const mcp = createMcpOAuthFixture({ baseUrl: process.env.HOB_SMOKE_MCP_BASE });
  const held = new Map();
  let recoveryRequests = 0, recoveryReleased = false, resumedRequests = 0;
  return createServer(async (req, res) => {
    if (await mcp(req, res)) return;
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && req.url === '/healthz') return json(200, { fixture: true });
    // Test-only controls on this disposable private-network provider, never app routes.
    if (req.method === 'GET' && req.url === '/smoke/recovery') return json(200, { requests: recoveryRequests, held: held.size, released: recoveryReleased, resumedRequests });
    if (req.method === 'POST' && req.url === '/smoke/recovery/release') {
      recoveryReleased = true;
      for (const [response, input] of held) completion(response, input, { role: 'assistant', content: SMOKE_RECOVERY_REPLY });
      held.clear();
      return json(200, { released: true });
    }
    if (req.method === 'GET' && req.url === '/v1/models') return json(200, { object: 'list', data: [{ id: SMOKE_MODEL, object: 'model', context_length: 128000 }] });
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(404, { error: 'Unknown fixture route.' });
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) return json(413, { error: 'Fixture request is too large.' });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(input?.messages)) return json(400, { error: 'Fixture messages are required.' });
      const asked = input.messages.some(item => item.role === 'user' && String(item.content).includes(SMOKE_PROMPT));
      const wrote = input.messages.some(item => item.role === 'tool' && item.tool_call_id === 'hob-smoke-write');
      const canWrite = input.tools?.some(tool => tool.function?.name === 'write_file');
      let tool = asked && !wrote && canWrite ? [{ id: 'hob-smoke-write', type: 'function', function: {
        name: 'write_file', arguments: JSON.stringify({ path: file, content: SMOKE_CONTENT }),
      } }] : null;
      const writeResult = input.messages.findLast(item => item.role === 'tool' && item.tool_call_id === 'hob-smoke-write');
      let writeReceipt;
      try { writeReceipt = JSON.parse(typeof writeResult?.content === 'string' ? writeResult.content : (writeResult?.content || []).map(item => item.text || '').join('')); } catch { /* The artifact assertion remains authoritative. */ }
      let content = asked && wrote ? (writeReceipt?.error ? 'HOB_WRITE_NOT_CONFIRMED: ' + JSON.stringify(writeReceipt).slice(0, 1200) : SMOKE_REPLY) : 'Synthetic smoke metadata.';
      const latestUser = input.messages.findLast(item => item.role === 'user');
      const latestText = String(latestUser?.content || '');
      const textParts = typeof latestUser?.content === 'string' ? latestUser.content : (latestUser?.content || []).map(part => part.text || '').join('\n');
      if (textParts.includes(SMOKE_ATTACHMENT_PROMPT)) {
        const received = Array.isArray(latestUser.content) && latestUser.content.some(part => part.type === 'image_url'
          && /^data:image\/png;base64,/.test(part.image_url?.url || ''));
        const shape = input.messages.filter(item => item.role === 'user').map(item => typeof item.content === 'string' ? 'text'
          : (item.content || []).map(part => ({ type: part.type, imageMime: String(part.image_url?.url || '').match(/^data:([^;,]+)/)?.[1] })));
        return completion(res, input, { role: 'assistant', content: received ? SMOKE_ATTACHMENT_REPLY : 'HOB_NATIVE_IMAGE_MISSING ' + JSON.stringify(shape) });
      }
      if (latestText.includes(SMOKE_RECOVERY_PROMPT)) {
        recoveryRequests++;
        if (recoveryReleased) return completion(res, input, { role: 'assistant', content: SMOKE_RECOVERY_REPLY });
        held.set(res, input);
        res.once('close', () => held.delete(res));
        return;
      }
      if (latestText.includes(SMOKE_RECOVERY_RESUME)) { resumedRequests++; tool = null; content = SMOKE_RECOVERY_RESUME; }
      if (latestText.includes(SMOKE_RELAY_PROMPT)) {
        const result = input.messages.findLast(item => item.role === 'tool' && item.tool_call_id === 'hob-smoke-relay');
        tool = !result && input.tools?.some(item => item.function?.name === 'terminal') ? [{ id: 'hob-smoke-relay', type: 'function', function: {
          name: 'terminal', arguments: JSON.stringify({ command: `${process.env.HOB_SMOKE_ISOLATION === 'users' ? 'test "$(id -u)" -ge 20000 && ' : ''}env -u API_SERVER_KEY -u HOB_TALK_TOKEN HOB_TALK_WAIT_MS=0 node ${process.env.HOB_SMOKE_RELAY_FILE || '/opt/data/workspaces/main/.hob/talk.mjs'} send ${SMOKE_WORKER_ID} ${SMOKE_WORKER_PROMPT}` }),
        } }] : null;
        content = result && /Exchange: [a-f0-9-]{36}/.test(JSON.stringify(result.content)) ? SMOKE_RELAY_REPLY
          : 'HOB_PROACTIVE_RELAY_NOT_CONFIRMED' + (result ? ': ' + JSON.stringify(result.content).slice(0, 1200) : '');
      } else if (latestText.includes('[HOB background result; exchange ') && latestText.includes(SMOKE_WORKER_PROMPT)) {
        tool = null; content = SMOKE_WAKE_REPLY;
      } else if (latestText.includes(SMOKE_WORKER_PROMPT)) {
        tool = null; content = SMOKE_WORKER_REPLY;
      } else if (latestText.includes(SMOKE_SCHEDULE_PROMPT)) {
        tool = null; content = SMOKE_SCHEDULE_REPLY;
      } else if (latestText.includes(SMOKE_HEARTBEAT_PROMPT)) {
        tool = null; content = SMOKE_HEARTBEAT_REPLY;
      }
      if (String(latestUser?.content).includes(SMOKE_SKILL_PROMPT)) {
        const result = input.messages.findLast(item => item.role === 'tool' && item.tool_call_id === 'hob-smoke-skill');
        tool = !result && input.tools?.some(item => item.function?.name === 'skill_manage') ? [{ id: 'hob-smoke-skill', type: 'function', function: {
          name: 'skill_manage', arguments: JSON.stringify({ operations: [{ action: 'create', name: SMOKE_SKILL_NAME, content: SMOKE_SKILL_CONTENT }] }),
        } }] : null;
        let staged;
        try { staged = JSON.parse(typeof result?.content === 'string' ? result.content : (result?.content || []).map(item => item.text || '').join('')); } catch { /* A malformed tool result cannot prove staging. */ }
        content = staged?.staged === true && /^[a-f0-9]{8}$/.test(staged.pending_id) ? SMOKE_SKILL_REPLY + ':' + staged.pending_id : 'HOB_CONTAINER_SKILL_NOT_STAGED';
      }
      const message = { role: 'assistant', content: tool ? null : content, ...(tool ? { tool_calls: tool } : {}) };
      return completion(res, input, message);
    } catch { if (!res.headersSent) json(400, { error: 'Invalid fixture request.' }); else res.end(); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.HOB_SMOKE_MODEL_PORT || 18793);
  const host = process.env.HOB_SMOKE_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid smoke model port.');
  if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('The smoke model binds loopback or the project network only.');
  const server = createSmokeModel();
  server.listen(port, host, () => console.log('hob smoke model listening on ' + host + ':' + port + '.'));
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
