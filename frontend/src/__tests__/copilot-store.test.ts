import { describe, it, expect, beforeEach } from 'vitest';
import { useCopilotStore } from '@/stores/copilotStore';
import { prepareAction } from '@/components/copilot/tools/approval';

beforeEach(() => {
  useCopilotStore.setState({
    open: false,
    mode: 'text',
    transcript: [],
    interim: { user: '', assistant: '' },
    pendingApproval: null,
    error: null,
    statusText: null,
  });
});

describe('copilotStore', () => {
  it('opens and toggles', () => {
    useCopilotStore.getState().setOpen(true);
    expect(useCopilotStore.getState().open).toBe(true);
    useCopilotStore.getState().toggleOpen();
    expect(useCopilotStore.getState().open).toBe(false);
  });

  it('adds a turn and returns its id', () => {
    const id = useCopilotStore.getState().addTurn({ role: 'user', text: 'hi', modality: 'text' });
    expect(typeof id).toBe('string');
    const t = useCopilotStore.getState().transcript;
    expect(t).toHaveLength(1);
    expect(t[0]?.id).toBe(id);
    expect(t[0]?.text).toBe('hi');
  });

  it('accumulates interim fragments', () => {
    useCopilotStore.getState().appendInterim('assistant', 'hel');
    useCopilotStore.getState().appendInterim('assistant', 'lo');
    expect(useCopilotStore.getState().interim.assistant).toBe('hello');
    useCopilotStore.getState().clearInterim();
    expect(useCopilotStore.getState().interim.assistant).toBe('');
  });

  it('updates a turn (e.g. feedback / fallback swap)', () => {
    const id = useCopilotStore.getState().addTurn({ role: 'assistant', text: 'x', modality: 'text' });
    useCopilotStore.getState().updateTurn(id, { feedback: 'UP', text: 'safe' });
    const turn = useCopilotStore.getState().transcript.find((t) => t.id === id);
    expect(turn?.feedback).toBe('UP');
    expect(turn?.text).toBe('safe');
  });

  it('sets and clears a pending approval; resetConversation wipes state', () => {
    const action = prepareAction({
      capabilityId: 'create_lead',
      toolName: 'create_lead',
      summary: 's',
      detail: [],
      endpoint: { method: 'POST', path: '/api/leads' },
      payload: { service_request: 'x' },
    });
    useCopilotStore.getState().setPendingApproval({ action });
    expect(useCopilotStore.getState().pendingApproval).not.toBeNull();
    useCopilotStore.getState().addTurn({ role: 'user', text: 'y', modality: 'text' });
    useCopilotStore.getState().resetConversation();
    expect(useCopilotStore.getState().transcript).toHaveLength(0);
    expect(useCopilotStore.getState().pendingApproval).toBeNull();
  });
});
