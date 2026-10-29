import { describe, it, expect } from 'vitest';
import { voiceReducer } from '@/components/copilot/voice/voiceState';

describe('voiceReducer', () => {
  it('connects then listens', () => {
    expect(voiceReducer('idle', { type: 'CONNECT' })).toBe('connecting');
    expect(voiceReducer('connecting', { type: 'CONNECTED' })).toBe('listening');
    expect(voiceReducer('listening', { type: 'MIC_ON' })).toBe('listening');
  });

  it('maps tool + speech events', () => {
    expect(voiceReducer('listening', { type: 'TOOL_RUNNING' })).toBe('thinking');
    expect(voiceReducer('thinking', { type: 'MODEL_SPEAKING' })).toBe('speaking');
  });

  it('barge-in returns to listening', () => {
    expect(voiceReducer('speaking', { type: 'INTERRUPTED' })).toBe('listening');
  });

  it('turn complete after speaking returns to listening', () => {
    expect(voiceReducer('speaking', { type: 'TURN_COMPLETE' })).toBe('listening');
    expect(voiceReducer('idle', { type: 'TURN_COMPLETE' })).toBe('idle');
  });

  it('error wins from any state; disconnect/mic-off go idle', () => {
    expect(voiceReducer('speaking', { type: 'ERROR' })).toBe('error');
    expect(voiceReducer('listening', { type: 'DISCONNECT' })).toBe('idle');
    expect(voiceReducer('listening', { type: 'MIC_OFF' })).toBe('idle');
  });
});
