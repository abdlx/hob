import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentProfile, ChatMessage, ChatSession, RightPanelTab, SecurityApproval, SystemStats, TaskItem } from '../types/chat';
import { chatApi } from '../services/api';
import { useLocation, useNavigate } from 'react-router-dom';
import { requestId } from '../services/id';
import { displayGatewayNotice } from '../services/errors';

interface ChatContextValue {
  messages: ChatMessage[]; sessions: ChatSession[]; activeSessionId: string;
  agent: AgentProfile | null; tasks: TaskItem[]; approvals: SecurityApproval[]; stats: SystemStats | null;
  activeTab: RightPanelTab; isRightPanelOpen: boolean; isLeftDrawerOpen: boolean; isLoading: boolean;
  activeNav: string; error: string | null; connected: boolean; isPreparing: boolean;
  setActiveNav: (nav: string) => void; sendMessage: (content: string) => Promise<void>;
  selectSession: (id: string) => Promise<void>; createNewSession: () => Promise<void>;
  setActiveTab: (tab: RightPanelTab) => void; toggleRightPanel: () => void; toggleLeftDrawer: () => void;
  resolveApproval: (id: string, decision: 'approved' | 'rejected') => Promise<void>;
  updateAgent: (partial: Partial<AgentProfile>) => Promise<void>; refresh: () => Promise<void>;
  clearError: () => void;
}
const ChatContext = createContext<ChatContextValue | undefined>(undefined);
const errorText = (error: unknown) => error instanceof Error ? displayGatewayNotice(error.message) : 'Unable to connect. Check gateway settings.';

export function ChatProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const sessionRef = useRef('');
  const sendingRef = useRef(false);
  const operationErrorRef = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [approvals, setApprovals] = useState<SecurityApproval[]>([]);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [activeTab, setActiveTab] = useState<RightPanelTab>('tasks');
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(window.innerWidth >= 768);
  const [isLeftDrawerOpen, setIsLeftDrawerOpen] = useState(false);
  const pathNav = location.pathname.split('/')[1];
  const activeNav = pathNav === 'ideas' ? 'idea' : ['feed', 'idea', 'goals', 'library', 'settings', 'search'].includes(pathNav) ? pathNav : 'chat';
  const setActiveNav = useCallback((nav: string) => { void navigate(nav === 'idea' ? '/ideas' : `/${nav}`); }, [navigate]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [isPreparing, setIsPreparing] = useState(true);

  const reconcileMessages = useCallback(async () => {
    const id = sessionRef.current;
    if (!id || sendingRef.current) return;
    try {
      const history = await chatApi.getMessages(id);
      if (sessionRef.current === id && !sendingRef.current) setMessages(history);
    } catch (err) { if (!operationErrorRef.current) setError(errorText(err)); }
  }, []);

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([chatApi.getSessions(), chatApi.getAgentProfile(), chatApi.getTasks(), chatApi.getSecurityApprovals(), chatApi.getSystemStats()]);
    const [sess, profile, activity, pending, system] = results;
    if (sess.status === 'fulfilled') setSessions(sess.value);
    if (profile.status === 'fulfilled') { setAgent(profile.value); setConnected(profile.value.status !== 'disconnected'); }
    if (activity.status === 'fulfilled') setTasks(activity.value);
    if (pending.status === 'fulfilled') setApprovals(pending.value);
    if (system.status === 'fulfilled') setStats(system.value);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') { if (!operationErrorRef.current) setError(errorText(failed.reason)); }
    else if (!operationErrorRef.current) setError(null);
    await reconcileMessages();
  }, [reconcileMessages]);

  useEffect(() => {
    let alive = true;
    async function initialize() {
      try {
        while (alive) {
          if ((await chatApi.getReadiness()).ready) break;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!alive) return;
        setIsPreparing(false);
        await refresh();
        const available = await chatApi.getSessions();
        if (!alive) return;
        const initial = available[0] || await chatApi.createSession();
        if (!alive || sessionRef.current) return;
        sessionRef.current = initial.id;
        setActiveSessionId(initial.id);
        setSessions(available.length ? available : [initial]);
        const history = await chatApi.getMessages(initial.id);
        if (alive && sessionRef.current === initial.id) setMessages(history);
      } catch (err) { if (alive) { setIsPreparing(false); setError(errorText(err)); } }
    }
    void initialize();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = chatApi.subscribe(frame => {
      if (frame.event === 'chat' && (frame.payload as { state?: string } | undefined)?.state === 'delta') return;
      if (document.visibilityState !== 'visible' && localStorage.getItem('mused-notifications') === 'enabled' && 'Notification' in window && Notification.permission === 'granted') {
        const approval = frame.event.endsWith('approval.requested');
        const payload = frame.payload as { action?: string; presentation?: { title?: string }; id?: string; jobId?: string } | undefined;
        const goalFinished = frame.event === 'cron' && payload?.action === 'finished';
        if (approval || goalFinished) {
          const notification = new Notification(approval ? 'OpenClaw needs your approval' : 'Scheduled goal finished', { body: approval ? payload?.presentation?.title || 'Open Approvals to review the request.' : 'Open Goals to review the result.', tag: payload?.id || payload?.jobId || frame.event });
          notification.onclick = () => { window.focus(); notification.close(); };
        }
      }
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (!alive) return;
        void refresh();
      }, 300);
    }, value => { if (alive) { setConnected(value); if (value) void refresh(); } });
    return () => { alive = false; unsubscribe(); clearTimeout(refreshTimer); };
  }, [refresh]);

  const selectSession = useCallback(async (id: string) => {
    sessionRef.current = id;
    setActiveSessionId(id); setMessages([]); setActiveNav('chat'); setIsLeftDrawerOpen(false);
    try { const history = await chatApi.getMessages(id); if (sessionRef.current === id) setMessages(history); }
    catch (err) { setError(errorText(err)); }
  }, [setActiveNav]);

  const createNewSession = useCallback(async () => {
    if (isPreparing) return;
    try {
      const session = await chatApi.createSession();
      setSessions(previous => [session, ...previous]);
      sessionRef.current = session.id; setActiveSessionId(session.id); setMessages([]);
      setActiveNav('chat'); setIsLeftDrawerOpen(false); setError(null);
    } catch (err) { setError(errorText(err)); }
  }, [setActiveNav, isPreparing]);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || sendingRef.current || isPreparing) return;
    sendingRef.current = true; operationErrorRef.current = false; setIsLoading(true); setError(null);
    let needsReconciliation = false;
    let id = sessionRef.current;
    try {
      if (!id) {
        const session = await chatApi.createSession();
        id = session.id; sessionRef.current = id; setActiveSessionId(id);
        setSessions(previous => [session, ...previous]);
      }
      const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const streamId = requestId();
      setMessages(previous => [...previous, { id: requestId(), role: 'user', content, timestamp, status: 'sending' }]);
      const reply = await chatApi.sendMessage(id, content, (chunk, replace) => {
        if (sessionRef.current !== id) return;
        setMessages(previous => {
          const last = previous.at(-1);
          return last?.id === streamId
            ? [...previous.slice(0, -1), { ...last, content: replace ? chunk : last.content + chunk }]
            : [...previous, { id: streamId, role: 'assistant', content: chunk, timestamp, status: 'streaming' }];
        });
      });
      if (sessionRef.current === id) setMessages(previous => [...previous.filter(item => item.id !== streamId).map(item => ({ ...item, status: 'complete' as const })), reply]);
      await refresh();
      const history = await chatApi.getMessages(id);
      if (sessionRef.current === id) setMessages(history);
    } catch (err) {
      operationErrorRef.current = true; needsReconciliation = true;
      setError(errorText(err));
      if (sessionRef.current === id) setMessages(previous => previous.map(item => item.status === 'streaming' || item.status === 'sending' ? { ...item, status: 'error' } : item));
    } finally { sendingRef.current = false; setIsLoading(false); if (needsReconciliation) await reconcileMessages(); }
  }, [refresh, reconcileMessages, isPreparing]);

  const resolveApproval = useCallback(async (id: string, decision: 'approved' | 'rejected') => {
    try { await chatApi.resolveSecurityApproval(id, decision); setApprovals(await chatApi.getSecurityApprovals()); }
    catch (err) { setError(errorText(err)); throw err; }
  }, []);
  const updateAgent = useCallback(async (partial: Partial<AgentProfile>) => {
    try { setAgent(await chatApi.updateAgentProfile(partial)); }
    catch (err) { setError(errorText(err)); throw err; }
  }, []);

  return <ChatContext.Provider value={{ messages, sessions, activeSessionId, agent, tasks, approvals, stats, activeTab, isRightPanelOpen, isLeftDrawerOpen, isLoading, activeNav, error, connected, isPreparing, setActiveNav, sendMessage, selectSession, createNewSession, setActiveTab, toggleRightPanel: () => setIsRightPanelOpen(value => !value), toggleLeftDrawer: () => setIsLeftDrawerOpen(value => !value), resolveApproval, updateAgent, refresh, clearError: () => { operationErrorRef.current = false; setError(null); } }}>{children}</ChatContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useChat() {
  const context = useContext(ChatContext);
  if (!context) throw new Error('useChat must be used within a ChatProvider');
  return context;
}
