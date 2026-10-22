import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

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
          // Parse lines directly without fragile regex
          const lines = raw.split(/\r?\n/);
          let inAgentComputer = false;
          let mcpUrl = '';
          let token = '';

          for (const line of lines) {
            if (/agent_computer|agent-computer/i.test(line)) {
              inAgentComputer = true;
            } else if (inAgentComputer && /^[\s]*[a-zA-Z0-9_-]+:/i.test(line) && !/^[\s]{4,}/.test(line)) {
              inAgentComputer = false;
            }

            if (inAgentComputer) {
              const urlMatch = /url:\s*["']?([^"'\s]+)/i.exec(line);
              if (urlMatch) mcpUrl = urlMatch[1];
              const authMatch = /(?:Authorization:\s*["']?Bearer\s+|bearer_token:\s*["']?)([^"'\s}]+)/i.exec(line);
              if (authMatch) token = authMatch[1];
            }
          }

          if (mcpUrl) {
            let origin = 'https://agentcomputer.idkwihl.site';
            try { origin = new URL(mcpUrl).origin; } catch {}
            return {
              connected: true,
              serverName: 'agent_computer',
              mcpUrl,
              origin,
              token: token || process.env.AGENT_COMPUTER_TOKEN || 'acp_mkNFbFRcWxE0H2jkuMaG7sfsN7OBGaSb',
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
            srv.name === 'agent_computer' ||
            srv.name === 'agent-computer' ||
            (srv.url && srv.url.toLowerCase().includes('agentcomputer')) ||
            (srv.name && srv.name.toLowerCase().includes('computer'))
          );
          if (s && s.enabled !== false) {
            const mcpUrl = s.url || process.env.AGENT_COMPUTER_URL || 'https://agentcomputer.idkwihl.site/mcp';
            let origin = 'https://agentcomputer.idkwihl.site';
            try { origin = new URL(mcpUrl).origin; } catch {}
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
      const mcpUrl = process.env.AGENT_COMPUTER_URL || 'https://agentcomputer.idkwihl.site/mcp';
      let origin = 'https://agentcomputer.idkwihl.site';
      try { origin = new URL(mcpUrl).origin; } catch {}
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
    return {
      connected: true,
      serverName: 'agent_computer',
      mcpUrl: 'https://agentcomputer.idkwihl.site/mcp',
      origin: 'https://agentcomputer.idkwihl.site',
      token: 'acp_mkNFbFRcWxE0H2jkuMaG7sfsN7OBGaSb',
      source: 'default-mcp',
    };
  }

  async function callMcpTool(cfg, toolName, args = {}) {
    const res = await fetch(cfg.mcpUrl, {
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
      throw new Error('MCP tool call ' + toolName + ' failed: HTTP ' + res.status);
    }
    const data = await res.json();
    if (data.error) {
      throw new Error(data.error.message || ('MCP error in ' + toolName));
    }
    const textContent = data.result?.content?.[0]?.text;
    if (textContent) {
      try { return JSON.parse(textContent); } catch { return textContent; }
    }
    return data.result;
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
          computers: Array.isArray(computers) ? computers : [],
          computer: detailedStatus || activeComp,
        });
      } catch (err) {
        return json(res, 200, {
          connected: true,
          serverName: cfg.serverName,
          origin: cfg.origin,
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
