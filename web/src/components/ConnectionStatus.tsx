import { CloudOff, RefreshCw } from 'lucide-react';
import { useChat } from '../context/ChatContext';

export function ConnectionStatus() {
  const { connectionIssue, isPreparing, isCreatingConversation } = useChat();
  if (!connectionIssue && !isPreparing && !isCreatingConversation) return null;
  const offline = connectionIssue === 'offline';
  return <div className="hob-connection-status mx-4 mt-3 flex shrink-0 items-center gap-3 rounded-2xl border border-hair bg-panel px-4 py-3 text-xs text-muted md:mx-6" role="status" aria-live="polite">
    {offline ? <CloudOff size={17} className="shrink-0" /> : <RefreshCw size={16} className="shrink-0 animate-spin motion-reduce:animate-none" />}
    <div className="min-w-0 flex-1"><p className="font-medium text-ink">{offline ? 'You’re offline' : connectionIssue ? 'Reconnecting to HOB…' : isCreatingConversation ? 'Creating your conversation…' : 'Getting your workspace ready…'}</p>
      <p className="mt-0.5 leading-relaxed">{connectionIssue ? 'Your task may still be running on the server. We’ll check its status when the connection returns.' : 'Loading your bot and saved conversation. Settings remain available.'}</p>
    </div>
    {connectionIssue && <button type="button" disabled={offline} onClick={() => window.dispatchEvent(new Event('hob:reconnect'))} className="min-h-10 shrink-0 rounded-xl px-3 font-medium text-accent hover:bg-hover disabled:opacity-40">Check now</button>}
  </div>;
}
