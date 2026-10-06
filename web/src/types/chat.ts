export type Role = 'user' | 'assistant' | 'system';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  output?: string;
  status: 'running' | 'completed' | 'failed';
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  timestamp: string; // e.g. "7:15 pm" or ISO string
  status?: 'sending' | 'streaming' | 'complete' | 'error';
  toolCalls?: ToolCall[];
}

export interface AgentProfile {
  id: string;
  name: string;
  status: 'connected' | 'idle' | 'busy' | 'disconnected';
  avatarUrl: string;
  roleDescription?: string;
  model?: string;
  agentRuntime?: string;
  systemPrompt?: string;
}

export type TaskStatus = 'completed' | 'in_progress' | 'cancelled' | 'pending';

export interface TaskItem {
  id: string;
  title: string;
  subtitle?: string;
  timestamp: string;
  status: TaskStatus;
  group?: string; // e.g. "Today", "Yesterday"
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  lastMessageSnippet?: string;
  agentId: string;
}

export type RightPanelTab = 'tasks' | 'security' | 'browser' | 'goals' | 'identity';

export interface SecurityApproval {
  id: string;
  type: 'command' | 'tool' | 'configuration' | 'filesystem' | 'network' | 'credential';
  description: string;
  commandSnippet?: string;
  riskLevel: 'low' | 'medium' | 'high';
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected';
}

export interface SystemStats {
  tokensUsed: number;
  maxTokens: number;
  memoryUsageMb: number;
  latencyMs: number;
  activeProcesses: number;
}
