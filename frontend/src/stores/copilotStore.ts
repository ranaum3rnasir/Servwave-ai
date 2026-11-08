import { create } from 'zustand';
import type { PreparedAction } from '@/components/copilot/tools/approval';
import type { VoiceState } from '@/components/copilot/voice/voiceState';

export type Connection = 'disconnected' | 'connecting' | 'connected' | 'error';
export type Mode = 'text' | 'voice';

export interface TranscriptTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  modality: Mode;
  label?: string; // e.g. 'draft_only_not_sent' | 'fallback'
  messageId?: string; // server message id (for feedback)
  feedback?: 'UP' | 'DOWN';
}

export interface PendingApproval {
  action: PreparedAction;
  callId?: string;
}

interface CopilotState {
  open: boolean;
  mode: Mode;
  connection: Connection;
  voiceState: VoiceState;
  micActive: boolean;
  /** Live mic RMS [0..~0.5] while recording — drives the orb animation. */
  micLevel: number;
  statusText: string | null;
  error: string | null;
  transcript: TranscriptTurn[];
  interim: { user: string; assistant: string };
  pendingApproval: PendingApproval | null;
  activeConversationId: string | null;

  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setMode: (mode: Mode) => void;
  setConnection: (c: Connection) => void;
  setVoiceState: (v: VoiceState) => void;
  setMicActive: (b: boolean) => void;
  setMicLevel: (n: number) => void;
  setStatusText: (s: string | null) => void;
  setError: (s: string | null) => void;
  appendInterim: (role: 'user' | 'assistant', fragment: string) => void;
  clearInterim: () => void;
  addTurn: (turn: Omit<TranscriptTurn, 'id'>) => string;
  updateTurn: (id: string, patch: Partial<TranscriptTurn>) => void;
  setPendingApproval: (p: PendingApproval | null) => void;
  setActiveConversationId: (id: string | null) => void;
  resetConversation: () => void;
}

let turnCounter = 0;
function nextId(): string {
  turnCounter += 1;
  return `t${turnCounter}`;
}

export const useCopilotStore = create<CopilotState>((set) => ({
  open: false,
  mode: 'text',
  connection: 'disconnected',
  voiceState: 'idle',
  micActive: false,
  micLevel: 0,
  statusText: null,
  error: null,
  transcript: [],
  interim: { user: '', assistant: '' },
  pendingApproval: null,
  activeConversationId: null,

  setOpen: (open) => set({ open }),
  toggleOpen: () => set((s) => ({ open: !s.open })),
  setMode: (mode) => set({ mode }),
  setConnection: (connection) => set({ connection }),
  setVoiceState: (voiceState) => set({ voiceState }),
  setMicActive: (micActive) => set({ micActive }),
  setMicLevel: (micLevel) => set({ micLevel }),
  setStatusText: (statusText) => set({ statusText }),
  setError: (error) => set({ error }),
  appendInterim: (role, fragment) =>
    set((s) => ({ interim: { ...s.interim, [role]: s.interim[role] + fragment } })),
  clearInterim: () => set({ interim: { user: '', assistant: '' } }),
  addTurn: (turn) => {
    const id = nextId();
    set((s) => ({ transcript: [...s.transcript, { ...turn, id }] }));
    return id;
  },
  updateTurn: (id, patch) =>
    set((s) => ({ transcript: s.transcript.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  setPendingApproval: (pendingApproval) => set({ pendingApproval }),
  setActiveConversationId: (activeConversationId) => set({ activeConversationId }),
  resetConversation: () =>
    set({
      transcript: [],
      interim: { user: '', assistant: '' },
      pendingApproval: null,
      activeConversationId: null,
      error: null,
      statusText: null,
    }),
}));
