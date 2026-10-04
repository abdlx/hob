import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from 'react';
import type {
  AgentProfile,
  ChatMessage,
  ChatSession,
  RightPanelTab,
  SecurityApproval,
  SystemStats,
  TaskItem,
} from '../types/chat';
import { chatApi } from '../services/api';

interface ChatContextValue {
  messages: ChatMessage[];
  sessions: ChatSession[];
  activeSessionId: string;
  agent: AgentProfile | null;
  tasks: TaskItem[];
  approvals: SecurityApproval[];
  stats: SystemStats | null;
  activeTab: RightPanelTab;
  isRightPanelOpen: boolean;
  isLeftDrawerOpen: boolean;
  isLoading: boolean;
  activeNav: string;
  setActiveNav: (nav: string) => void;
  sendMessage: (content: string) => Promise<void>;
  selectSession: (sessionId: string) => void;
  createNewSession: () => Promise<void>;
  setActiveTab: (tab: RightPanelTab) => void;
  toggleRightPanel: () => void;
  toggleLeftDrawer: () => void;
  resolveApproval: (id: string, decision: 'approved' | 'rejected') => Promise<void>;
  updateAgent: (partial: Partial<AgentProfile>) => void;
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('session-default');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [approvals, setApprovals] = useState<SecurityApproval[]>([]);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [activeTab, setActiveTab] = useState<RightPanelTab>('tasks');
  const [isRightPanelOpen, setIsRightPanelOpen] = useState<boolean>(
    typeof window !== 'undefined' ? window.innerWidth >= 768 : true
  );
  const [isLeftDrawerOpen, setIsLeftDrawerOpen] = useState<boolean>(false);
  const [activeNav, setActiveNav] = useState<string>('chat');
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // Initialize data on mount
  useEffect(() => {
    let isMounted = true;
    async function loadInitialData() {
      try {
        const [sess, ag, tsk, appr, st] = await Promise.all([
          chatApi.getSessions(),
          chatApi.getAgentProfile(),
          chatApi.getTasks(),
          chatApi.getSecurityApprovals(),
          chatApi.getSystemStats(),
        ]);
        if (!isMounted) return;
        setSessions(sess);
        setAgent(ag);
        setTasks(tsk);
        setApprovals(appr);
        setStats(st);

        const defaultId = sess[0]?.id || 'session-default';
        setActiveSessionId(defaultId);
        const msgs = await chatApi.getMessages(defaultId);
        if (isMounted) setMessages(msgs);
      } catch (err) {
        console.error('Failed to load initial chat state:', err);
      }
    }
    loadInitialData();
    return () => {
      isMounted = false;
    };
  }, []);

  // When active session changes, load its messages
  const selectSession = useCallback(async (sessionId: string) => {
    setActiveSessionId(sessionId);
    try {
      const msgs = await chatApi.getMessages(sessionId);
      setMessages(msgs);
      setIsLeftDrawerOpen(false); // Close drawer on mobile/desktop selection
    } catch (err) {
      console.error(`Failed to load messages for session ${sessionId}:`, err);
    }
  }, []);

  const createNewSession = useCallback(async () => {
    try {
      const newSession = await chatApi.createSession('New Conversation');
      setSessions((prev) => [newSession, ...prev]);
      setActiveSessionId(newSession.id);
      setMessages([]);
      setIsLeftDrawerOpen(false);
    } catch (err) {
      console.error('Failed to create new session:', err);
    }
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isLoading) return;

      const userMsg: ChatMessage = {
        id: `temp-usr-${Date.now()}`,
        role: 'user',
        content,
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
        status: 'complete',
      };

      // Optimistically append user message
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);

      try {
        await chatApi.sendMessage(activeSessionId, content, (chunk) => {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && last.status === 'streaming') {
              return [
                ...prev.slice(0, -1),
                { ...last, content: last.content + chunk },
              ];
            } else {
              return [
                ...prev,
                {
                  id: `stream-ast-${Date.now()}`,
                  role: 'assistant',
                  content: chunk,
                  timestamp: new Date().toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                  status: 'streaming',
                },
              ];
            }
          });
        });

        // Refresh latest messages and tasks from API store
        const [updatedMsgs, updatedTasks] = await Promise.all([
          chatApi.getMessages(activeSessionId),
          chatApi.getTasks(),
        ]);
        setMessages(updatedMsgs);
        setTasks(updatedTasks);
      } catch (err) {
        console.error('Error sending message:', err);
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: 'assistant',
            content: '⚠️ Failed to connect to agent backend. Please check connection.',
            timestamp: new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            }),
            status: 'error',
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    },
    [activeSessionId, isLoading]
  );

  const resolveApproval = useCallback(
    async (id: string, decision: 'approved' | 'rejected') => {
      await chatApi.resolveSecurityApproval(id, decision);
      const updated = await chatApi.getSecurityApprovals();
      setApprovals(updated);
    },
    []
  );

  const toggleRightPanel = useCallback(() => {
    setIsRightPanelOpen((prev) => !prev);
  }, []);

  const toggleLeftDrawer = useCallback(() => {
    setIsLeftDrawerOpen((prev) => !prev);
  }, []);

  const updateAgent = useCallback((partial: Partial<AgentProfile>) => {
    setAgent((prev) => (prev ? { ...prev, ...partial } : prev));
  }, []);

  return (
    <ChatContext.Provider
      value={{
        messages,
        sessions,
        activeSessionId,
        agent,
        tasks,
        approvals,
        stats,
        activeTab,
        isRightPanelOpen,
        isLeftDrawerOpen,
        isLoading,
        activeNav,
        setActiveNav,
        sendMessage,
        selectSession,
        createNewSession,
        setActiveTab,
        toggleRightPanel,
        toggleLeftDrawer,
        resolveApproval,
        updateAgent,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
};
