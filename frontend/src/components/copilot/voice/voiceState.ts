/**
 * Pure voice state machine: maps Gemini Live events to one of the seven orb
 * states the UI renders. No side effects — easy to unit-test.
 */

export type VoiceState =
  | 'idle' // not connected / mic off
  | 'connecting'
  | 'listening' // connected, mic open, waiting for / hearing the user
  | 'thinking' // a tool call is running
  | 'speaking' // the model is talking
  | 'error';

export type VoiceEvent =
  | { type: 'CONNECT' }
  | { type: 'CONNECTED' }
  | { type: 'MIC_ON' }
  | { type: 'MIC_OFF' }
  | { type: 'USER_SPEAKING' }
  | { type: 'TOOL_RUNNING' }
  | { type: 'MODEL_SPEAKING' }
  | { type: 'INTERRUPTED' } // barge-in
  | { type: 'TURN_COMPLETE' }
  | { type: 'ERROR' }
  | { type: 'DISCONNECT' };

export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case 'ERROR':
      return 'error';
    case 'DISCONNECT':
    case 'MIC_OFF':
      return 'idle';
    case 'CONNECT':
      return 'connecting';
    case 'CONNECTED':
    case 'MIC_ON':
    case 'USER_SPEAKING':
    case 'INTERRUPTED': // barge-in stops playback and returns to listening
      return 'listening';
    case 'TOOL_RUNNING':
      return 'thinking';
    case 'MODEL_SPEAKING':
      return 'speaking';
    case 'TURN_COMPLETE':
      // after the model finishes, go back to listening if we were mid-exchange
      return state === 'speaking' || state === 'thinking' ? 'listening' : state;
    default:
      return state;
  }
}
