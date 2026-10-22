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
  /** Who answered; shown above the bubble when several members share a conversation. */
  sender?: string;
  /** Hermes profile that owns local media referenced by this message. */
  profile?: string;
  toolCalls?: ToolCall[];
}

export interface AgentListItem {
  id: string;
  name: string;
  avatarUrl?: string;
  roleDescription?: string;
  model?: string;
  status?: 'connected' | 'idle' | 'busy' | 'disconnected';
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

export type TaskStatus = 'completed' | 'in_progress' | 'cancelled' | 'pending' | 'failed' | 'interrupted' | 'unknown';

export interface TaskItem {
  id: string;
  title: string;
  subtitle?: string;
  timestamp: string;
  status: TaskStatus;
  group?: string; // e.g. "Today", "Yesterday"
  agentId?: string; // Owning bot, when the server attributes it
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  lastMessageSnippet?: string;
  agentId: string;
  transport?: 'canonical' | 'api';
  readOnly?: boolean;
}

export type RightPanelTab = 'tasks' | 'security' | 'browser' | 'goals' | 'identity';

export interface GroupMember {
  id: string;
  profile: string;
  name: string;
  handle: string;
}

export interface GroupSummary {
  id: string;
  name: string;
  members: GroupMember[];
  disbanded: boolean;
}

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
