import { useEffect, useMemo, useRef, useState } from 'react';
import { hermesSetupApi, setupLink } from '../services/hermes-setup';
import { buttonClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

interface Flow {
  id: string; serverName: string; status: string; expiresAt: number; canClose: boolean;
  authorizationUrl?: string; error?: string;
}
const write = (method: string, value: unknown = {}) => ({ method, body: JSON.stringify(value) });

export function HermesMcpOAuth({ profile, name }: { profile: string; name: string }) {
  const api = useMemo(() => hermesSetupApi(profile), [profile]);
  const [flow, setFlow] = useState<Flow | null>(null), [error, setError] = useState('');
  const [review, setReview] = useState(false), [busy, setBusy] = useState(false);
  const mounted = useRef(false), pending = useRef(false), revision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const current = ++revision.current;
    void api<{ flows: Flow[] }>('mcp/oauth/flows').then(result => {
      if (active && current === revision.current) setFlow(result.flows.find(item => item.serverName === name) || null);
    }).catch(error => { if (active && current === revision.current) setError(errorText(error)); });
    return () => { active = false; mounted.current = false; };
  }, [api, name]);
  useEffect(() => {
    if (!flow || !['starting', 'authorization_required'].includes(flow.status)) return;
    let active = true;
    const current = revision.current;
    const timer = window.setTimeout(() => {
      void api<Flow>(`mcp/oauth/flows/${encodeURIComponent(flow.id)}`).then(result => {
        if (active && current === revision.current) setFlow(result);
      }).catch(error => { if (active && current === revision.current) setError(errorText(error)); });
    }, 1500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [api, flow]);
  const action = async (work: () => Promise<Flow | null>) => {
    if (pending.current) return;
    const current = ++revision.current;
    pending.current = true; setBusy(true); setError('');
    try { const result = await work(); if (mounted.current && current === revision.current) setFlow(result); }
    catch (error) {
      if (mounted.current && current === revision.current) setError(errorText(error));
      // Observe the owned attempt after an uncertain start; never replay it.
      try {
        const result = await api<{ flows: Flow[] }>('mcp/oauth/flows');
        if (mounted.current && current === revision.current) setFlow(result.flows.find(item => item.serverName === name) || null);
      } catch { /* Preserve the original error. */ }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const link = setupLink(flow?.authorizationUrl);
  const present = flow && flow.status !== 'cancelled';
  return <div className="space-y-2">
    {error && <Notice error>{error}</Notice>}
    {!present && !review && <button className={buttonClass} disabled={busy} onClick={() => setReview(true)}>Sign in to MCP server</button>}
    {review && <Notice>Start sign-in to {name} for this bot? Hermes will contact the server to discover its authorization provider. Review that provider’s page before granting access.
      {' '}<button className={buttonClass} disabled={busy} onClick={() => { setReview(false); void action(() => api<Flow>(`mcp/${encodeURIComponent(name)}/auth`, write('POST', { confirm: true }))); }}>Confirm MCP sign-in</button>
      {' '}<button className={buttonClass} disabled={busy} onClick={() => setReview(false)}>Cancel sign-in confirmation</button>
    </Notice>}
    {present && <Notice>
      {flow.status === 'approved' ? 'Hermes completed sign-in. Use Test connection to verify the saved credential and tools.'
        : flow.status === 'authorization_required' ? 'Open the authorization provider, finish sign-in there, then return here. Status updates automatically.'
          : flow.error || 'Hermes is preparing sign-in.'}
      {link && flow.status === 'authorization_required' && <p><a className="underline" href={link} target="_blank" rel="noreferrer noopener">Open MCP authorization provider</a></p>}
      <p className="text-xs">Closing an attempt does not disconnect credentials already saved by Hermes.</p>
      <button className={buttonClass} disabled={busy} onClick={() => action(() => api<Flow>(`mcp/oauth/flows/${encodeURIComponent(flow.id)}`))}>Check sign-in status</button>
      {' '}<button className={buttonClass} disabled={busy || !flow.canClose} onClick={() => action(() => api<Flow>(`mcp/oauth/flows/${encodeURIComponent(flow.id)}`, write('DELETE')))}>Close sign-in attempt</button>
    </Notice>}
  </div>;
}
