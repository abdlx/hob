export interface Bot { id: string; name: string; model?: string; roleDescription?: string; avatarUrl?: string; status?: string; tags?: string[]; lastMessageSnippet?: string }
export interface Session { id: string; title: string; createdAt: string; lastMessageSnippet?: string; agentId: string; readOnly?: boolean }
export interface ChatMessage { id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: string; status?: string; profile?: string }
export interface TurnActivity { label: string; phase?: string; tool?: string }
export interface Attachment { uploadId?: string; id: string; name: string; mime: string; size: number }
export interface LibraryEntry { name: string; path: string; directory: boolean; size?: number }
export interface FilePreview { name: string; dataUrl: string; mimeType: string; size: number }
export interface Skill { name: string; description?: string; enabled: boolean; provenance?: string }
export interface Job { id: string; name: string; prompt?: string; schedule: string | Record<string, unknown>; enabled?: boolean; state?: string; next_run_at?: string; last_status?: string }
export type RootStackParams = {
  Bots: { profile?: string } | undefined;
  Chat: { profile: string; id?: string; title?: string; readOnly?: boolean; draft?: string };
  Conversations: { profile: string };
  Activity: { profile: string };
  Workshop: { profile: string };
  Goals: { profile: string };
  Goal: { profile: string; job?: Job };
  Library: { profile: string; path?: string };
  File: { profile: string; file: LibraryEntry };
  Skills: { profile: string };
  Skill: { profile: string; name?: string };
  Memory: { profile: string };
  MemoryEntry: { profile: string; id: string; label: string };
  Identity: { profile: string };
  Tools: { profile: string };
  Browser: { profile: string };
  WebSettings: { profile: string };
  Settings: { profile: string };
  Appearance: { profile: string };
  Model: { profile: string };
  Connection: undefined;
  Review: { profile: string; subsystem: 'skills' | 'memory'; id: string; revision: string };
};
