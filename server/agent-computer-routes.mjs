import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

function isAgentComputerUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  if (lower.includes('openrouter') || lower.includes('openai') || lower.includes('anthropic') || lower.includes('deepseek') || lower.includes('together') || lower.includes('groq')) {
    return false;
  }
  return true;
}

function normalizeMcpUrl(rawUrl, defaultOrigin = 'https://agentcomputer.idkwihl.site') {
  if (!rawUrl || typeof rawUrl !== 'string' || !isAgentComputerUrl(rawUrl)) {
    return `${defaultOrigin}/mcp`;
  }
  let str = rawUrl.trim().replace(/\/+$/, '');
  try {
    const u = new URL(str);
    if (!u.pathname || u.pathname === '/' || u.pathname === '') {
      u.pathname = '/mcp';
      return u.href;
    }
    if (!u.pathname.endsWith('/mcp')) {
      u.pathname = u.pathname.replace(/\/+$/, '') + '/mcp';
      return u.href;
    }
    return u.href;
  } catch {
    return `${defaultOrigin}/mcp`;
  }
}

function getOrigin(rawUrl, defaultOrigin = 'https://agentcomputer.idkwihl.site') {
  try {
    const origin = new URL(rawUrl).origin;
    if (isAgentComputerUrl(origin)) return origin;
    return defaultOrigin;
  } catch {
    return defaultOrigin;
  }
}

export function createAgentComputerRoutes({ client, hermesHome } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  async function getAgentComputerConfig(profile = 'default') {
    // 1. Check config.yaml in hermesHome or standard locations
    const candidatePaths = [
      hermesHome ? path.join(hermesHome, 'config.yaml') : null,
      hermesHome && profile !== 'default' ? path.join(hermesHome, 'profiles', profile, 'config.yaml') : null,
      '/opt/data/config.yaml',
      process.env.HERMES_CONFIG_PATH,
    ].filter(Boolean);

    for (const filePath of candidatePaths) {
      try {
        if (fs.existsSync(filePath)) {
          const raw = fs.readFileSync(filePath, 'utf8');
          let parsedUrl = '';
          let parsedToken = '';

          // 1a. Try JSON parse if config is stored as JSON
          try {
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              const srv = parsed.mcp_servers?.agent_computer || parsed.mcp_servers?.['agent-computer'];
              if (srv) {
                if (srv.url && isAgentComputerUrl(srv.url)) parsedUrl = srv.url;
                const auth = srv.headers?.Authorization || srv.headers?.authorization || '';
                const m = /Bearer\s+([^\s"']+)/i.exec(auth);
                if (m) parsedToken = m[1];
              }
            }
          } catch {}

          // 1b. Line-by-line regex with strict indentation tracking
          if (!parsedToken) {
            const lines = raw.split(/\r?\n/);
            let inAgent = false;
            let agentIndent = 0;
            for (const line of lines) {
              const startMatch = /^(\s*)["']?agent[-_]computer["']?\s*:/i.exec(line);
              if (startMatch) {
                inAgent = true;
                agentIndent = startMatch[1].length;
                continue;
              }
              if (inAgent) {
                const indentMatch = /^(\s*)\S/.exec(line);
                if (indentMatch && indentMatch[1].length <= agentIndent) {
                  inAgent = false;
                }
              }
              if (inAgent) {
                const u = /["']?url["']?\s*:\s*["']?([^"'\s,]+)/i.exec(line);
                if (u && isAgentComputerUrl(u[1])) parsedUrl = u[1];
                const t = /(?:Authorization["']?\s*:\s*["']?Bearer\s+|bearer_token["']?\s*:\s*["']?)([^"'\s},]+)/i.exec(line);
                if (t) parsedToken = t[1];
              }
            }
          }

          if (parsedToken || parsedUrl) {
            const mcpUrl = normalizeMcpUrl(parsedUrl || 'https://agentcomputer.idkwihl.site/mcp');
            const origin = getOrigin(mcpUrl);
            return {
              connected: true,
              serverName: 'agent_computer',
              mcpUrl,
              origin,
              token: parsedToken || process.env.AGENT_COMPUTER_TOKEN || 'acp_mkNFbFRcWxE0H2jkuMaG7sfsN7OBGaSb',
              source: filePath,
            };
          }
        }
      } catch {
        // continue
      }
    }

    // 2. Check Hermes dashboard API
    if (client?.dashboard) {
      try {
        const res = await client.dashboard('/api/mcp/servers', { profile });
        if (Array.isArray(res?.servers)) {
          const s = res.servers.find(srv =>
            (srv.name === 'agent_computer' || srv.name === 'agent-computer') ||
            (srv.url && isAgentComputerUrl(srv.url) && srv.url.toLowerCase().includes('agentcomputer'))
          );
          if (s && s.enabled !== false) {
            const rawUrl = s.url || process.env.AGENT_COMPUTER_URL || 'https://agentcomputer.idkwihl.site/mcp';
            const mcpUrl = normalizeMcpUrl(rawUrl);
            const origin = getOrigin(mcpUrl);
            const token = process.env.AGENT_COMPUTER_TOKEN || 'acp_mkNFbFRcWxE0H2jkuMaG7sfsN7OBGaSb';
            return {
              connected: true,
              serverName: s.name,
              mcpUrl,
              origin,
              token,
              source: 'hermes-dashboard',
            };
          }
        }
      } catch {
        // continue
      }
    }

    // 3. Fallback to process.env if explicitly set or default if connected
    if (process.env.AGENT_COMPUTER_URL || process.env.AGENT_COMPUTER_TOKEN) {
      const mcpUrl = normalizeMcpUrl(process.env.AGENT_COMPUTER_URL);
      const origin = getOrigin(mcpUrl);
      return {
        connected: true,
        serverName: 'agent_computer',
        mcpUrl,
        origin,
        token: process.env.AGENT_COMPUTER_TOKEN || 'acp_mkNFbFRcWxE0H2jkuMaG7sfsN7OBGaSb',
        source: 'env',
      };
    }

    // 4. Default fallback: user indicated agent_computer is registered in /opt/data/config.yaml
    const defaultUrl = normalizeMcpUrl('https://agentcomputer.idkwihl.site/mcp');
    return {
      connected: true,
      serverName: 'agent_computer',
      mcpUrl: defaultUrl,
      origin: getOrigin(defaultUrl),
      token: 'acp_mkNFbFRcWxE0H2jkuMaG7sfsN7OBGaSb',
      source: 'default-mcp',
    };
  }

  async function callMcpTool(cfg, toolName, args = {}) {
    const normalizedUrl = normalizeMcpUrl(cfg.mcpUrl, cfg.origin || 'https://agentcomputer.idkwihl.site');
    const endpointsToTry = [
      normalizedUrl,
      (cfg.origin ? `${cfg.origin.replace(/\/+$/, '')}/mcp` : 'https://agentcomputer.idkwihl.site/mcp'),
    ];

    let lastError = null;
    const uniqueEndpoints = [...new Set(endpointsToTry)];

    for (const targetUrl of uniqueEndpoints) {
      try {
        const res = await fetch(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cfg.token ? { 'Authorization': 'Bearer ' + cfg.token } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: {
              name: toolName,
              arguments: args,
            },
          }),
        });

        if (!res.ok) {
          let errBody = '';
          try { errBody = await res.text(); } catch {}
          lastError = new Error(`MCP tool call ${toolName} failed (${targetUrl}): HTTP ${res.status}${errBody ? ' - ' + errBody.slice(0, 100) : ''}`);
          continue;
        }

        const data = await res.json();
        if (data.error) {
          throw new Error(data.error.message || (`MCP error in ${toolName}`));
        }
        const textContent = data.result?.content?.[0]?.text;
        if (textContent) {
          try { return JSON.parse(textContent); } catch { return textContent; }
        }
        return data.result;
      } catch (err) {
        lastError = err;
      }
    }

    // Direct REST API fallback on the control plane if MCP call encounters ANY error (404, 405, network, etc.)
    const origin = (cfg.origin || 'https://agentcomputer.idkwihl.site').replace(/\/+$/, '');
    if (toolName === 'computer_list') {
      try {
        const res = await fetch(`${origin}/api/computers`, {
          headers: {
            'Content-Type': 'application/json',
            ...(cfg.token ? { 'Authorization': 'Bearer ' + cfg.token } : {}),
          },
        });
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json.computers)) return json.computers;
        }
      } catch {}
    } else if (toolName === 'computer_status' && args.computer) {
      try {
        const res = await fetch(`${origin}/api/computers/${encodeURIComponent(args.computer)}`, {
          headers: {
            'Content-Type': 'application/json',
            ...(cfg.token ? { 'Authorization': 'Bearer ' + cfg.token } : {}),
          },
        });
        if (res.ok) {
          const json = await res.json();
          return json.computer || json;
        }
      } catch {}
    } else if (toolName === 'computer_wake' && args.computer) {
      try {
        const res = await fetch(`${origin}/api/computers/${encodeURIComponent(args.computer)}/wake`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cfg.token ? { 'Authorization': 'Bearer ' + cfg.token } : {}),
          },
        });
        if (res.ok) {
          return await res.json();
        }
      } catch {}
    } else if (toolName === 'computer_sleep' && args.computer) {
      try {
        const res = await fetch(`${origin}/api/computers/${encodeURIComponent(args.computer)}/sleep`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cfg.token ? { 'Authorization': 'Bearer ' + cfg.token } : {}),
          },
        });
        if (res.ok) {
          return await res.json();
        }
      } catch {}
    }

    throw lastError || new Error(`MCP tool call ${toolName} failed`);
  }

  async function route(req, res, url, { json, body }) {
    if (!url.pathname.startsWith('/api/hermes/agent-computer')) return false;

    const profile = url.searchParams.get('profile') || 'default';
    const cfg = await getAgentComputerConfig(profile);

    if (url.pathname === '/api/hermes/agent-computer/status' && req.method === 'GET') {
      if (!cfg.connected) {
        return json(res, 200, { connected: false });
      }
      try {
        const computers = await callMcpTool(cfg, 'computer_list', {});
        const activeComp = Array.isArray(computers) && computers.length > 0 ? computers[0] : null;
        let detailedStatus = null;
        if (activeComp) {
          try {
            detailedStatus = await callMcpTool(cfg, 'computer_status', { computer: activeComp.id });
          } catch {}
        }
        return json(res, 200, {
          connected: true,
          serverName: cfg.serverName,
          origin: cfg.origin,
          mcpUrl: cfg.mcpUrl,
          computers: Array.isArray(computers) ? computers : [],
          computer: detailedStatus || activeComp,
        });
      } catch (err) {
        return json(res, 200, {
          connected: true,
          serverName: cfg.serverName,
          origin: cfg.origin,
          mcpUrl: cfg.mcpUrl,
          error: err.message,
        });
      }
    }

    if (url.pathname === '/api/hermes/agent-computer/wake' && req.method === 'POST') {
      if (!cfg.connected) return json(res, 400, { error: 'Agent computer MCP is not connected.' });
      const payload = await body(req);
      const computerId = payload?.computerId || 'main-agent-153436';
      try {
        const result = await callMcpTool(cfg, 'computer_wake', { computer: computerId });
        return json(res, 200, { ok: true, result });
      } catch (err) {
        return json(res, 502, { error: err.message });
      }
    }

    if (url.pathname === '/api/hermes/agent-computer/sleep' && req.method === 'POST') {
      if (!cfg.connected) return json(res, 400, { error: 'Agent computer MCP is not connected.' });
      const payload = await body(req);
      const computerId = payload?.computerId || 'main-agent-153436';
      try {
        const result = await callMcpTool(cfg, 'computer_sleep', { computer: computerId });
        return json(res, 200, { ok: true, result });
      } catch (err) {
        return json(res, 502, { error: err.message });
      }
    }

    return false;
  }

  function upgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://hob.local'); } catch { return false; }
    if (url.pathname !== '/api/hermes/agent-computer/vnc') return false;

    const profile = url.searchParams.get('profile') || 'default';
    const computerId = url.searchParams.get('computerId') || 'main-agent-153436';

    void (async () => {
      const cfg = await getAgentComputerConfig(profile);
      if (!cfg.connected) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, clientWs => {
        const upstreamWsUrl = cfg.origin.replace(/^http/, 'ws') + '/api/computers/' + encodeURIComponent(computerId) + '/vnc?token=' + encodeURIComponent(cfg.token);
        const upstreamWs = new WebSocket(upstreamWsUrl, ['binary'], {
          headers: {
            Authorization: 'Bearer ' + cfg.token,
          },
        });

        clientWs.on('message', (msg, isBinary) => {
          if (upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.send(msg, { binary: isBinary });
          }
        });

        upstreamWs.on('message', (msg, isBinary) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(msg, { binary: isBinary });
          }
        });

        clientWs.on('close', () => {
          try { upstreamWs.close(); } catch {}
        });
        upstreamWs.on('close', () => {
          try { clientWs.close(); } catch {}
        });
        clientWs.on('error', () => {
          try { upstreamWs.close(); } catch {}
        });
        upstreamWs.on('error', (err) => {
          console.warn('[agent-computer-vnc-proxy] upstream error:', err.message);
          try { clientWs.close(1011, 'upstream error'); } catch {}
        });
      });
    })();

    return true;
  }

  return { route, upgrade, getAgentComputerConfig };
}
