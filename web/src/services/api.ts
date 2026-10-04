import type {
  AgentProfile,
  ChatMessage,
  ChatSession,
  SecurityApproval,
  SystemStats,
  TaskItem,
} from '../types/chat';

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: 'msg-1',
    role: 'assistant',
    content: `• wisp — light, quick, ethereal. A helper that's just... there when you need it.
• puck — Shakespeare's trickster sprite. Memorable, playful.
• miso — soft and cute, honestly just fun to say.

My pick is **hob**. The metaphor is perfect — it lives in your house, works while you're away, and nobody else's agent is named that.`,
    timestamp: '7:11 pm',
    status: 'complete',
  },
  {
    id: 'msg-2',
    role: 'user',
    content: 'ok hob it is. what should be the name of my git repo',
    timestamp: '7:12 pm',
    status: 'complete',
  },
  {
    id: 'msg-3',
    role: 'assistant',
    content: `Just **hob**. Flagship repos go by the product name — openclaw/openclaw, facebook/react. So yours is **yourusername/hob**, nice and clean.`,
    timestamp: '7:12 pm',
    status: 'complete',
  },
  {
    id: 'msg-4',
    role: 'user',
    content: 'what license should i add',
    timestamp: '7:13 pm',
    status: 'complete',
  },
  {
    id: 'msg-5',
    role: 'assistant',
    content: `**MIT — same as OpenClaw.** Three reasons: it keeps you license-compatible with the code you're forking (merging upstream changes stays painless), it's the least friction for homelab tinkerers to adopt, and it's one short file instead of pages of legalese.

Two things to know:
• Since you're forking OpenClaw, keep their copyright/license notices on the code you carry over. Your own additions can be under your name, same MIT terms.
• The only real alternative worth considering is **AGPLv3** — it closes the loophole where someone hosts your code as a proprietary service without sharing changes. But it also shrinks your contributor pool and complicates the fork relationship. For a homelab tool where adoption matters more than defense, MIT wins.

So: copy OpenClaw's LICENSE, add your copyright line for your changes, done.`,
    timestamp: '7:14 pm',
    status: 'complete',
  },
  {
    id: 'msg-6',
    role: 'user',
    content: 'give me a github decsription',
    timestamp: '7:14 pm',
    status: 'complete',
  },
  {
    id: 'msg-7',
    role: 'assistant',
    content: `Your self-hosted personal AI agent — a house-spirit for your homelab that does chores while you sleep.`,
    timestamp: '7:15 pm',
    status: 'complete',
  },
];

const INITIAL_TASKS: TaskItem[] = [
  {
    id: 't-1',
    title: 'Compare React/Capacitor vs Expo vs Next.js',
    subtitle: 'Asked for your final choice',
    timestamp: '7:15 pm',
    status: 'completed',
    group: 'Today',
  },
  {
    id: 't-2',
    title: 'Investigate OpenClaw repo size',
    subtitle: 'Opened the OpenClaw GitHub page without investigating repo size',
    timestamp: '6:33 pm',
    status: 'completed',
    group: 'Today',
  },
  {
    id: 't-3',
    title: 'Compare Hermes vs OpenClaw',
    subtitle: 'Asked for details to proceed',
    timestamp: '5:45 pm',
    status: 'completed',
    group: 'Today',
  },
  {
    id: 't-4',
    title: 'Report non-consensual video in Pakistan',
    subtitle: 'Found FIA reporting portal and free helpline',
    timestamp: '2:28 pm',
    status: 'completed',
    group: 'Today',
  },
  {
    id: 't-5',
    title: 'Compare OpenClaw vs Hermer Agent',
    subtitle: 'Reviewed the OpenClaw vs Hermes comparison blog',
    timestamp: '2:17 pm',
    status: 'completed',
    group: 'Today',
  },
  {
    id: 't-6',
    title: 'Research OpenClaw for agent layer',
    subtitle: 'Found OpenClaw architecture brief and recent sources',
    timestamp: '2:13 pm',
    status: 'completed',
    group: 'Today',
  },
  {
    id: 't-7',
    title: 'Scope open-source Muse clone',
    subtitle: 'Build cancelled before repo was produced',
    timestamp: '2:12 pm',
    status: 'cancelled',
    group: 'Today',
  },
  {
    id: 't-8',
    title: 'Stop project scaffolding',
    subtitle: '',
    timestamp: '2:12 pm',
    status: 'completed',
    group: 'Today',
  },
];

const INITIAL_AGENT: AgentProfile = {
  id: 'agent-dogesh',
  name: 'Dogesh',
  status: 'connected',
  avatarUrl: '/dogesh.png',
  roleDescription: 'Personal AI Companion & Homelab Agent',
  model: 'gemini-2.5-flash / hermes-3',
};

const INITIAL_SESSIONS: ChatSession[] = [
  {
    id: 'session-default',
    title: 'Naming repo & license',
    createdAt: 'Today',
    lastMessageSnippet: 'Your self-hosted personal AI agent...',
    agentId: 'agent-dogesh',
  },
  {
    id: 'session-2',
    title: 'OpenClaw architecture comparison',
    createdAt: 'Yesterday',
    lastMessageSnippet: 'Reviewed the OpenClaw vs Hermes...',
    agentId: 'agent-dogesh',
  },
  {
    id: 'session-3',
    title: 'Docker homelab setup',
    createdAt: '3 days ago',
    lastMessageSnippet: 'Configuring docker-compose.yml for background turns',
    agentId: 'agent-dogesh',
  },
];

const INITIAL_APPROVALS: SecurityApproval[] = [
  {
    id: 'appr-1',
    type: 'command',
    description: 'Execute `git remote add origin git@github.com:user/hob.git`',
    commandSnippet: 'git remote add origin git@github.com:user/hob.git',
    riskLevel: 'medium',
    requestedAt: '7:16 pm',
    status: 'pending',
  },
  {
    id: 'appr-2',
    type: 'filesystem',
    description: 'Write default LICENSE (MIT) to workspace root',
    riskLevel: 'low',
    requestedAt: '7:14 pm',
    status: 'approved',
  },
];

const INITIAL_STATS: SystemStats = {
  tokensUsed: 14280,
  maxTokens: 128000,
  memoryUsageMb: 342,
  latencyMs: 145,
  activeProcesses: 1,
};

class ChatApiClient {
  private baseUrl: string;
  private isMock: boolean;
  private messages: Map<string, ChatMessage[]> = new Map();
  private sessions: ChatSession[] = [...INITIAL_SESSIONS];
  private tasks: TaskItem[] = [...INITIAL_TASKS];
  private agent: AgentProfile = { ...INITIAL_AGENT };
  private approvals: SecurityApproval[] = [...INITIAL_APPROVALS];
  private stats: SystemStats = { ...INITIAL_STATS };

  constructor() {
    this.baseUrl = import.meta.env.VITE_API_BASE_URL || '';
    this.isMock = !this.baseUrl || import.meta.env.VITE_USE_MOCK_API === 'true';
    this.messages.set('session-default', [...INITIAL_MESSAGES]);
  }

  // --- Session Management ---
  async getSessions(): Promise<ChatSession[]> {
    if (!this.isMock) {
      const res = await fetch(`${this.baseUrl}/api/sessions`);
      return res.json();
    }
    return [...this.sessions];
  }

  async createSession(title: string = 'New Conversation'): Promise<ChatSession> {
    if (!this.isMock) {
      const res = await fetch(`${this.baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, agentId: this.agent.id }),
      });
      return res.json();
    }
    const newSession: ChatSession = {
      id: `session-${Date.now()}`,
      title,
      createdAt: 'Just now',
      agentId: this.agent.id,
    };
    this.sessions.unshift(newSession);
    this.messages.set(newSession.id, []);
    return newSession;
  }

  // --- Messages ---
  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    if (!this.isMock) {
      const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/messages`);
      return res.json();
    }
    return this.messages.get(sessionId) || [];
  }

  async sendMessage(
    sessionId: string,
    content: string,
    onChunk?: (token: string) => void
  ): Promise<ChatMessage> {
    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: 'complete',
    };

    const currentList = this.messages.get(sessionId) || [];
    currentList.push(userMessage);
    this.messages.set(sessionId, currentList);

    if (!this.isMock) {
      // Real API integration (supports SSE or fetch)
      const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });

      if (res.body && onChunk) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullResponse = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          fullResponse += text;
          onChunk(text);
        }
        const assistantMsg: ChatMessage = {
          id: `msg-${Date.now() + 1}`,
          role: 'assistant',
          content: fullResponse,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status: 'complete',
        };
        currentList.push(assistantMsg);
        return assistantMsg;
      }
      return res.json();
    }

    // Mock response with realistic streaming feel
    const simulatedAnswers = [
      `I've noted that! I'm coordinating with your background homelab daemon to handle that right away.`,
      `Working on that. I've updated the task workboard and checked repository permissions.`,
      `Got it. I'll stage that change and verify compatibility with your OpenClaw agent configuration.`,
      `Done! The configuration has been recorded. What would you like to tackle next?`,
    ];
    const replyText =
      simulatedAnswers[Math.floor(Math.random() * simulatedAnswers.length)];

    const assistantMsg: ChatMessage = {
      id: `msg-${Date.now() + 1}`,
      role: 'assistant',
      content: '',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: 'streaming',
    };
    currentList.push(assistantMsg);

    // Stream mock tokens
    const words = replyText.split(' ');
    for (let i = 0; i < words.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 35));
      const word = (i === 0 ? '' : ' ') + words[i];
      assistantMsg.content += word;
      if (onChunk) onChunk(word);
    }
    assistantMsg.status = 'complete';

    // Also auto-add a task to the timeline to reflect agent activity!
    this.tasks.unshift({
      id: `task-${Date.now()}`,
      title: content.length > 32 ? `${content.slice(0, 32)}...` : content,
      subtitle: 'Processed turn and updated state',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: 'completed',
      group: 'Today',
    });

    return assistantMsg;
  }

  // --- Agent Profile ---
  async getAgentProfile(): Promise<AgentProfile> {
    if (!this.isMock) {
      const res = await fetch(`${this.baseUrl}/api/agent`);
      return res.json();
    }
    return { ...this.agent };
  }

  async updateAgentProfile(updates: Partial<AgentProfile>): Promise<AgentProfile> {
    this.agent = { ...this.agent, ...updates };
    return { ...this.agent };
  }

  // --- Tasks / Activity Timeline ---
  async getTasks(): Promise<TaskItem[]> {
    if (!this.isMock) {
      const res = await fetch(`${this.baseUrl}/api/tasks`);
      return res.json();
    }
    return [...this.tasks];
  }

  // --- Security Approvals ---
  async getSecurityApprovals(): Promise<SecurityApproval[]> {
    if (!this.isMock) {
      const res = await fetch(`${this.baseUrl}/api/security/approvals`);
      return res.json();
    }
    return [...this.approvals];
  }

  async resolveSecurityApproval(
    id: string,
    decision: 'approved' | 'rejected'
  ): Promise<void> {
    if (!this.isMock) {
      await fetch(`${this.baseUrl}/api/security/approvals/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      return;
    }
    this.approvals = this.approvals.map((appr) =>
      appr.id === id ? { ...appr, status: decision } : appr
    );
  }

  // --- Stats ---
  async getSystemStats(): Promise<SystemStats> {
    if (!this.isMock) {
      const res = await fetch(`${this.baseUrl}/api/stats`);
      return res.json();
    }
    return { ...this.stats };
  }
}

export const chatApi = new ChatApiClient();
