/** Public DTOs contain no access tokens or API keys. */
export type AIProvider = 'openai-codex' | 'openai';
export type AIMode = 'chat' | 'create' | 'revise' | 'writeback' | 'workspace';
export interface AIMessage { role: 'user' | 'assistant'; content: string }
export interface AIContext {
  document?: { id: string; title: string; html: string; revision: number };
  selection?: { text: string; from?: number; to?: number };
  threadId?: string;
}
export type AIEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; phase: 'start' | 'end'; error?: boolean }
  | { type: 'done'; text: string; model: string; provider: AIProvider };
export interface AIRunOptions {
  messages: AIMessage[];
  context?: AIContext;
  mode: AIMode;
  provider?: AIProvider;
  model?: string;
  signal?: AbortSignal;
  onEvent?: (event: AIEvent) => void | Promise<void>;
  tools?: {
    createDocument?: (input: { title: string; html: string }, signal?: AbortSignal) => Promise<unknown>;
    proposeEdit?: (input: { replacement: string; explanation: string }, signal?: AbortSignal) => Promise<unknown>;
    readDocument?: (signal?: AbortSignal) => Promise<unknown>;
  };
}
export interface AIStatus {
  ready: boolean;
  provider: AIProvider;
  model: string;
  providers: { id: AIProvider; configured: boolean; kind: 'subscription' | 'api-key' }[];
  models: { id: string; name: string; provider: AIProvider }[];
  note: string;
}
export interface AILoginState {
  id: string;
  status: 'starting' | 'waiting' | 'complete' | 'failed' | 'cancelled';
  url?: string;
  instructions?: string;
  prompt?: string;
  error?: string;
}
