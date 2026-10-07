import type { JSONContent } from '@tiptap/core';
export type Content = JSONContent;
export interface NoteSummary { id: string; title: string; updatedAt: string; revision: number; }
export interface Message { id: string; role: 'user' | 'assistant'; text: string; createdAt: string; }
export interface Proposal { canUndo?: boolean; id: string; threadId: string; baseRevision: number; original: string; replacementHtml: string; explanation: string; state: 'pending' | 'applied' | 'rejected' | 'undone'; }
export interface Discussion { id: string; quote: string; createdAt: string; resolved: boolean; detached: boolean; messages: Message[]; proposals: Proposal[]; }
export interface Note extends NoteSummary { content: Content; threads: Discussion[]; sourceUrl?: string; }
export interface AIStatus { configured: boolean; provider: string; model: string; models: {id: string; name: string}[]; busy?: boolean; }
