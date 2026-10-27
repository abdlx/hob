import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentListItem, AgentProfile, ChatMessage, ChatSession, GroupSummary, RightPanelTab, SecurityApproval, SystemStats, TaskItem } from '../types/chat';
import { chatApi, apiFetch } from '../services/api';
import { useLocation, useNavigate } from 'react-router-dom';
import type { ChatAttachment } from '../services/attachments';
import { requestId } from '../services/id';
import { displayGatewayNotice } from '../services/errors';
import { ConversationWork } from '../services/conversation-work';

interface ChatContextValue {
  messages: ChatMessage[]; sessions: ChatSession[]; activeSessionId: string;
  agent: AgentProfile | null; tasks: TaskItem[]; approvals: SecurityApproval[]; stats: SystemStats | null;
  agents: AgentListItem[]; selectAgent: (id: string, options?: { stayOnPage?: boolean }) => Promise<void>;
  activeTab: RightPanelTab; isRightPanelOpen: boolean; isLeftDrawerOpen: boolean; isLoading: boolean;
  isBotsSidebarOpen: boolean; toggleBotsSidebar: () => void; setBotsSidebarOpen: (open: boolean) => void;
  activeNav: string; error: string | null; connected: boolean; isPreparing: boolean; isCreatingConversation: boolean;
  activityFilter: string | null; setActivityFilter: (id: string | null) => void;
  groups: GroupSummary[]; loadGroups: () => Promise<void>;
  selectedGroupId: string; setSelectedGroupId: (id: string) => void;
  setActiveNav: (nav: string) => void; sendMessage: (content: string, attachments?: ChatAttachment[]) => Promise<void>;
  selectSession: (id: string) => Promise<void>; createNewSession: () => Promise<void>;
  setActiveTab: (tab: RightPanelTab) => void; toggleRightPanel: () => void; toggleLeftDrawer: () => void;
  resolveApproval: (id: string, decision: 'approved' | 'rejected') => Promise<void>;
  updateAgent: (partial: Partial<AgentProfile>) => Promise<void>; refresh: () => Promise<void>;
  clearError: () => void;
  getComposerDraft: (id: string) => string; setComposerDraft: (id: string, text: string) => void;
  subscribeComposerDraft: (id: string, listener: () => void) => () => void;
}
const ChatContext = createContext<ChatContextValue | undefined>(undefined);
const errorText = (error: unknown) => error instanceof Error ? displayGatewayNotice(error.message) : 'Unable to connect. Check gateway settings.';

export function ChatProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const sessionRef = useRef('');
  const workRef = useRef(new ConversationWork());
  const creatingRef = useRef(new Set<string>());
  const profileLoadingRef = useRef(false);
  const viewEpochRef = useRef(0);
  const refreshSequenceRef = useRef(0);
  const rosterSequenceRef = useRef(0);
  const lastSessionsRef = useRef(new Map<string, string>());
  const operationErrorRef = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [approvals, setApprovals] = useState<SecurityApproval[]>([]);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [activeTab, setActiveTab] = useState<RightPanelTab>('tasks');
  const [activityFilter, setActivityFilter] = useState<string | null>(null);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const loadGroups = useCallback(async () => {
    const result = await apiFetch<{ groups: GroupSummary[] }>('/api/hermes/groups', { headers: { 'X-Hob-Profile': 'default' } });
    setGroups(Array.isArray(result.groups) ? result.groups : []);
  }, []);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(window.innerWidth >= 768);
  const [isLeftDrawerOpen, setIsLeftDrawerOpen] = useState(false);
  const [isBotsSidebarOpen, setIsBotsSidebarOpen] = useState(() => {
    const saved = localStorage.getItem('mused-bots-sidebar-open');
    if (saved !== null) return saved === 'true';
    return window.innerWidth >= 1024;
  });
  const toggleBotsSidebar = useCallback(() => {
    setIsBotsSidebarOpen(prev => {
      const next = !prev;
      localStorage.setItem('mused-bots-sidebar-open', String(next));
      return next;
    });
  }, []);
  const setBotsSidebarOpen = useCallback((open: boolean) => {
    setIsBotsSidebarOpen(open);
    localStorage.setItem('mused-bots-sidebar-open', String(open));
  }, []);
  const pathNav = location.pathname.split('/')[1];
  const activeNav = pathNav === 'ideas' ? 'idea' : ['activity', 'idea', 'goals', 'library', 'settings', 'search', 'groups'].includes(pathNav) ? pathNav : 'chat';
  const setActiveNav = useCallback((nav: string) => { void navigate(nav === 'idea' ? '/ideas' : `/${nav}`); }, [navigate]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [isPreparing, setIsPreparing] = useState(true);
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);
  const getComposerDraft = useCallback((id: string) => workRef.current.draft(id), []);
  const setComposerDraft = useCallback((id: string, text: string) => workRef.current.setDraft(id, text), []);
  const subscribeComposerDraft = useCallback((id: string, listener: () => void) => workRef.current.subscribeDraft(id, listener), []);

  const reconcileMessages = useCallback(async () => {
    const isPreview = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === '1';
    if (isPreview) return;
    const id = sessionRef.current;
    if (!id || workRef.current.busy(id)) return;
    const profile = chatApi.getProfile(), epoch = viewEpochRef.current, version = workRef.current.version(id);
    try {
      const history = await chatApi.forProfile(profile).getMessages(id);
      if (sessionRef.current === id && chatApi.getProfile() === profile && viewEpochRef.current === epoch
        && workRef.current.version(id) === version && !workRef.current.busy(id)) setMessages(history);
    } catch (err) {
      if (sessionRef.current === id && chatApi.getProfile() === profile && viewEpochRef.current === epoch && !operationErrorRef.current) setError(errorText(err));
    }
  }, []);

  const loadAgents = useCallback(async () => {
    const sequence = ++rosterSequenceRef.current;
    const roster = await chatApi.getAgents();
    if (sequence === rosterSequenceRef.current) setAgents(roster.agents);
  }, []);

  const refresh = useCallback(async () => {
    const isPreview = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === '1';
    if (isPreview) return;
    const selectedProfile = chatApi.getProfile();
    const api = chatApi.forProfile(selectedProfile), epoch = viewEpochRef.current, sequence = ++refreshSequenceRef.current;
    const results = await Promise.allSettled([api.getSessions(), api.getAgentProfile(), api.getTasks(), api.getSecurityApprovals(), api.getSystemStats(), loadAgents()]);
    if (selectedProfile !== chatApi.getProfile() || viewEpochRef.current !== epoch || refreshSequenceRef.current !== sequence) return;
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
  }, [reconcileMessages, loadAgents]);

  useEffect(() => {
    let alive = true;
    const rosterRequests = rosterSequenceRef;
    async function initialize() {
      const isPreview = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === '1';
      if (isPreview) {
        setIsPreparing(false);
        setConnected(true);
        setError(null);
        const mainBot: AgentProfile = { id: 'main', name: 'Main', model: 'gpt-4o', status: 'connected', roleDescription: 'Helpful personal assistant', avatarUrl: '' };
        setAgent(mainBot);
        setAgents([
          { id: 'main', name: 'Main', model: 'OpenAI GPT-4o', roleDescription: 'Helpful personal assistant' },
          { id: 'scout', name: 'Scout', model: 'Claude 3.5 Sonnet', roleDescription: 'Research & exploration bot' },
          { id: 'hermes', name: 'Hermes', model: 'Hermes 3 Llama', roleDescription: 'Local tool executor' },
          { id: 'atlas', name: 'Atlas', model: 'DeepSeek V3', roleDescription: 'Code and workflows' },
        ]);
        const sampleSession: ChatSession = { id: 'preview-session-1', agentId: 'main', title: 'Conversation with Main', createdAt: 'Today' };
        setSessions([sampleSession]);
        setActiveSessionId('preview-session-1');
        setMessages([
          {
            id: 'm1',
            role: 'assistant',
            content: "Hello! I'm Main, your personal assistant. What would you like to work on today?",
            timestamp: '11:20 AM',
          },
          {
            id: 'm2',
            role: 'user',
            content: 'Could you give me an overview of our project architecture?',
            timestamp: '11:21 AM',
          },
          {
            id: 'm3',
            role: 'assistant',
            content: "Everything is running smoothly! All responsive screen layouts, floating controls, and navigation bars are configured edge-to-edge.",
            timestamp: '11:22 AM',
          },
        ]);
        return;
      }
      const selectedProfile = chatApi.getProfile();
      const api = chatApi.forProfile(selectedProfile), epoch = viewEpochRef.current;
      try {
        while (alive) {
          if ((await api.getReadiness()).ready) break;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!alive) return;
        await refresh();
        const available = await api.getSessions();
        if (!alive) return;
        const initial = available.find(session => !session.readOnly) || await api.createSession();
        if (!alive || sessionRef.current || selectedProfile !== chatApi.getProfile() || viewEpochRef.current !== epoch) return;
        sessionRef.current = initial.id;
        lastSessionsRef.current.set(selectedProfile, initial.id);
        setActiveSessionId(initial.id);
        setSessions(available.some(session => session.id === initial.id) ? available : [initial, ...available]);
        const history = await api.getMessages(initial.id);
        if (alive && sessionRef.current === initial.id && viewEpochRef.current === epoch) { setMessages(history); setIsPreparing(false); }
      } catch (err) { if (alive) { setIsPreparing(false); setError(errorText(err)); } }
    }
    void initialize();
    // Unopened bots can finish unattended work without an attached chat stream.
    const rosterTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && new URLSearchParams(window.location.search).get('preview') !== '1') {
        void loadAgents().catch(() => {});
      }
    }, 15000);
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = chatApi.subscribe(frame => {
      if (frame.event === 'bot.exchange') {
        window.dispatchEvent(new CustomEvent('hob:bot-exchange', { detail: frame.payload }));
        return;
      }
      if (frame.event === 'chat' && (frame.payload as { state?: string } | undefined)?.state === 'delta') return;
      if (document.visibilityState !== 'visible' && localStorage.getItem('mused-notifications') === 'enabled' && 'Notification' in window && Notification.permission === 'granted') {
        const approval = frame.event.endsWith('approval.requested');
        const payload = frame.payload as { action?: string; presentation?: { title?: string }; id?: string; jobId?: string } | undefined;
        const goalFinished = frame.event === 'cron' && payload?.action === 'finished';
        if (approval || goalFinished) {
          const notification = new Notification(approval ? 'Your agent needs approval' : 'Scheduled goal finished', { body: approval ? payload?.presentation?.title || 'Open Approvals to review the request.' : 'Open Goals to review the result.', tag: payload?.id || payload?.jobId || frame.event });
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
    return () => { alive = false; unsubscribe(); clearTimeout(refreshTimer); window.clearInterval(rosterTimer); rosterRequests.current++; };
  }, [refresh, loadAgents]);

  const selectSession = useCallback(async (id: string) => {
    if (profileLoadingRef.current || isPreparing) return;
    const profile = chatApi.getProfile(), epoch = ++viewEpochRef.current, version = workRef.current.version(id);
    sessionRef.current = id;
    lastSessionsRef.current.set(profile, id);
    operationErrorRef.current = Boolean(workRef.current.error(id));
    setError(workRef.current.error(id)); setIsLoading(workRef.current.busy(id));
    setActiveSessionId(id); setMessages(workRef.current.project(id, [])); setActiveNav('chat'); setIsLeftDrawerOpen(false);
    try {
      const history = await chatApi.forProfile(profile).getMessages(id);
      if (sessionRef.current === id && viewEpochRef.current === epoch && workRef.current.version(id) === version) setMessages(workRef.current.project(id, history));
    } catch (err) { if (sessionRef.current === id && viewEpochRef.current === epoch) setError(errorText(err)); }
  }, [setActiveNav, isPreparing]);

  const createNewSession = useCallback(async () => {
    if (isPreparing) return;
    const profile = chatApi.getProfile();
    if (creatingRef.current.has(profile)) return;
    const epoch = ++viewEpochRef.current;
    creatingRef.current.add(profile);
    setIsCreatingConversation(true);
    try {
      const session = await chatApi.forProfile(profile).createSession();
      if (chatApi.getProfile() !== profile || viewEpochRef.current !== epoch) return;
      setSessions(previous => [session, ...previous]);
      sessionRef.current = session.id; setActiveSessionId(session.id); setMessages([]);
      lastSessionsRef.current.set(profile, session.id); setIsLoading(false); operationErrorRef.current = false;
      setActiveNav('chat'); setIsLeftDrawerOpen(false); setError(null);
    } catch (err) { if (chatApi.getProfile() === profile && viewEpochRef.current === epoch) setError(errorText(err)); }
    finally { creatingRef.current.delete(profile); if (chatApi.getProfile() === profile) setIsCreatingConversation(false); }
  }, [setActiveNav, isPreparing]);

  const selectAgent = useCallback(async (id: string, options: { stayOnPage?: boolean } = {}) => {
    const isPreview = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === '1';
    if (isPreview) {
      const found = agents.find((a) => a.id === id) || { id, name: id.charAt(0).toUpperCase() + id.slice(1), model: 'OpenAI GPT-4o' };
      setAgent({ id: found.id, name: found.name, model: found.model || 'gpt-4o', status: 'connected', avatarUrl: found.avatarUrl || '' });
      setActiveSessionId(`preview-${id}`);
      setSessions([{ id: `preview-${id}`, agentId: id, title: `Chat with ${found.name}`, createdAt: 'Just now' }]);
      setMessages([
        {
          id: `welcome-${id}`,
          role: 'assistant',
          content: `Hi! I'm ${found.name}. What can we build or research today?`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      if (!options.stayOnPage) setActiveNav('chat');
      return;
    }
    if (profileLoadingRef.current || isPreparing || id === chatApi.getProfile()) return;
    profileLoadingRef.current = true;
    const epoch = ++viewEpochRef.current, api = chatApi.forProfile(id);
    setIsCreatingConversation(false);
    setIsLoading(false); setError(null); operationErrorRef.current = false;
    setIsPreparing(true);
    sessionRef.current = '';
    setActiveSessionId(''); setMessages([]); setSessions([]); setApprovals([]); setTasks([]); setStats(null); setAgent(null);
    try {
      chatApi.setProfile(id);
      await refresh();
      const available = await api.getSessions();
      const remembered = lastSessionsRef.current.get(id);
      const initial = available.find(session => session.id === remembered) || available.find(session => !session.readOnly) || await api.createSession();
      if (viewEpochRef.current !== epoch || chatApi.getProfile() !== id) return;
      sessionRef.current = initial.id;
      lastSessionsRef.current.set(id, initial.id);
      setIsLoading(workRef.current.busy(initial.id));
      operationErrorRef.current = Boolean(workRef.current.error(initial.id)); setError(workRef.current.error(initial.id));
      setActiveSessionId(initial.id);
      setSessions(available.some(session => session.id === initial.id) ? available : [initial, ...available]);
      const version = workRef.current.version(initial.id);
      setMessages(workRef.current.project(initial.id, []));
      const history = await api.getMessages(initial.id);
      if (viewEpochRef.current === epoch && sessionRef.current === initial.id && workRef.current.version(initial.id) === version) setMessages(workRef.current.project(initial.id, history));
      if (!options.stayOnPage) setActiveNav('chat');
    } catch (error) { if (viewEpochRef.current === epoch && chatApi.getProfile() === id) setError(errorText(error)); }
    finally {
      profileLoadingRef.current = false;
      if (viewEpochRef.current === epoch) { setIsPreparing(false); setIsCreatingConversation(creatingRef.current.has(id)); }
    }
  }, [isPreparing, refresh, setActiveNav, agents]);

  const sendMessage = useCallback(async (content: string, attachments: ChatAttachment[] = []) => {
    const isPreview = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === '1';
    if (isPreview) {
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const userMessage: ChatMessage = {
        id: `preview-user-${Date.now()}`,
        role: 'user',
        content,
        timestamp: time,
      };
      setMessages((prev) => [...prev, userMessage]);
      setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          {
            id: `preview-ai-${Date.now()}`,
            role: 'assistant',
            content: `Understood! Working on "${content}".`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
      }, 250);
      return;
    }
    const profile = chatApi.getProfile(), api = chatApi.forProfile(profile), epoch = viewEpochRef.current;
    if (!content.trim() || workRef.current.busy(sessionRef.current) || creatingRef.current.has(profile) || isPreparing) return;
    if (sessions.find(session => session.id === sessionRef.current)?.readOnly) {
      setError('This older conversation is read-only. Start a new conversation to continue with Hermes.'); return;
    }
    operationErrorRef.current = false; setIsLoading(true); setError(null);
    let id = sessionRef.current;
    let work: ReturnType<ConversationWork['begin']> | undefined;
    let creating = false;
    try {
      if (!id) {
        creating = true; creatingRef.current.add(profile);
        setIsCreatingConversation(true);
        const session = await api.createSession();
        id = session.id;
        creatingRef.current.delete(profile); creating = false;
        if (chatApi.getProfile() === profile) setIsCreatingConversation(false);
        if (chatApi.getProfile() === profile && viewEpochRef.current === epoch && !sessionRef.current) {
          sessionRef.current = id; setActiveSessionId(id); lastSessionsRef.current.set(profile, id);
          setSessions(previous => [session, ...previous]);
        }
      }
      const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const current = work = workRef.current.begin(profile, id, content, requestId(), requestId(), timestamp, sessionRef.current === id ? messages : []);
      if (sessionRef.current === id && chatApi.getProfile() === profile) setMessages(previous => workRef.current.project(id, previous));
      const reply = await api.sendMessage(id, content, (chunk, replace) => {
        if (!workRef.current.append(current, chunk, replace)) return;
        if (sessionRef.current === id && chatApi.getProfile() === profile) setMessages(previous => workRef.current.project(id, previous));
      }, current.user.id, attachments.map(file => file.id));
      if (!workRef.current.finish(current)) return;
      if (sessionRef.current === id && chatApi.getProfile() === profile) setMessages(previous => [...previous.filter(item => item.id !== current.reply.id).map(item => ({ ...item, status: 'complete' as const })), reply]);
      await refresh();
    } catch (err) {
      if (work) workRef.current.finish(work, errorText(err));
      if (chatApi.getProfile() === profile && (sessionRef.current === id || (!id && viewEpochRef.current === epoch))) {
        operationErrorRef.current = true; setError(errorText(err));
        setMessages(previous => previous.map(item => item.status === 'streaming' || item.status === 'sending' ? { ...item, status: 'error' } : item));
      }
    } finally {
      if (creating) { creatingRef.current.delete(profile); if (chatApi.getProfile() === profile) setIsCreatingConversation(false); }
      if (chatApi.getProfile() === profile && sessionRef.current === id) setIsLoading(workRef.current.busy(id));
      await reconcileMessages();
    }
  }, [refresh, reconcileMessages, isPreparing, sessions, messages]);

  const resolveApproval = useCallback(async (id: string, decision: 'approved' | 'rejected') => {
    const profile = chatApi.getProfile(), api = chatApi.forProfile(profile), epoch = viewEpochRef.current;
    try {
      await api.resolveSecurityApproval(id, decision);
      const pending = await api.getSecurityApprovals();
      if (chatApi.getProfile() === profile && viewEpochRef.current === epoch) setApprovals(pending);
    } catch (err) { if (chatApi.getProfile() === profile && viewEpochRef.current === epoch) setError(errorText(err)); throw err; }
  }, []);
  const updateAgent = useCallback(async (partial: Partial<AgentProfile>) => {
    const profile = chatApi.getProfile(), api = chatApi.forProfile(profile), epoch = viewEpochRef.current;
    try { const updated = await api.updateAgentProfile(partial); if (chatApi.getProfile() === profile && viewEpochRef.current === epoch) setAgent(updated); }
    catch (err) { if (chatApi.getProfile() === profile && viewEpochRef.current === epoch) setError(errorText(err)); throw err; }
  }, []);

  const openingNativeConversation = useRef(false);
  useEffect(() => {
    const open = async () => {
      const target = window.__hobPendingConversation;
      if (!target || isPreparing || profileLoadingRef.current || openingNativeConversation.current) return;
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(target.profile) || !/^[A-Za-z0-9_-]{1,1024}$/.test(target.sessionKey)) { delete window.__hobPendingConversation; return; }
      openingNativeConversation.current = true;
      try {
        await selectAgent(target.profile, { stayOnPage: true });
        if (chatApi.getProfile() !== target.profile) return;
        const available = await chatApi.forProfile(target.profile).getSessions();
        if (!available.some(session => session.id === target.sessionKey)) throw new Error('That notification conversation is no longer available.');
        delete window.__hobPendingConversation;
        await selectSession(target.sessionKey);
        window.dispatchEvent(new Event('hob:conversation-opened'));
      } catch (error) { delete window.__hobPendingConversation; setError(errorText(error)); }
      finally { openingNativeConversation.current = false; }
    };
    const receive = () => { void open(); };
    window.addEventListener('hob:open-conversation', receive);
    const timer = setTimeout(receive, 0);
    return () => { clearTimeout(timer); window.removeEventListener('hob:open-conversation', receive); };
  }, [isPreparing, selectAgent, selectSession]);

  return <ChatContext.Provider value={{ messages, sessions, activeSessionId, agent, agents, selectAgent, tasks, approvals, stats, activeTab, isRightPanelOpen, isLeftDrawerOpen, isBotsSidebarOpen, toggleBotsSidebar, setBotsSidebarOpen, isLoading, activeNav, error, connected, isPreparing, isCreatingConversation, activityFilter, setActivityFilter, groups, loadGroups, selectedGroupId, setSelectedGroupId, setActiveNav, sendMessage, selectSession, createNewSession, setActiveTab, toggleRightPanel: () => setIsRightPanelOpen(value => !value), toggleLeftDrawer: () => setIsLeftDrawerOpen(value => !value), resolveApproval, updateAgent, refresh, getComposerDraft, setComposerDraft, subscribeComposerDraft, clearError: () => { operationErrorRef.current = false; workRef.current.clearError(sessionRef.current); setError(null); } }}>{children}</ChatContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useChat() {
  const context = useContext(ChatContext);
  if (!context) throw new Error('useChat must be used within a ChatProvider');
  return context;
}
