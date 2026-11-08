/**
 * Gemini Live session manager — Servy's real-time voice transport.
 *
 * Opens ONE WebSocket from the browser straight to Gemini Live with a single-use
 * ephemeral token (the API key never reaches the client). The Live model is the
 * "mouth": it streams the user's mic up and native audio down, and for any CRM
 * question/action it calls the single `ask_servy` tool (NON_BLOCKING — it can
 * say "one sec…" while the real brain works). The caller wires `onToolCall` to
 * the existing conversation loop + tool bridge and feeds the answer back with
 * `sendToolResponse`; `sendSystemNote` voices approval-card outcomes.
 *
 * This module owns sound + socket only; all CRM reasoning stays in the brain.
 */
import { GoogleGenAI, Modality, Behavior, type LiveServerMessage, type Session } from '@google/genai';
import { MicStreamer, SpeakerQueue, base64ToInt16, int16ToBase64, rmsLevel } from './liveAudio';
import { vlog, vwarn } from './voiceLog';
import { tapSentChunk } from './voiceDebugTap';

export interface LiveFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface LiveSessionHandlers {
  onOpen: () => void;
  /** inputTranscription fragment — what the user is saying. */
  onUserFragment: (text: string) => void;
  /** outputTranscription fragment — what Servy is saying. */
  onAssistantFragment: (text: string) => void;
  /** A user+assistant exchange finished — commit the live transcript bubbles. */
  onTurnComplete: () => void;
  /** Barge-in: the user spoke over Servy; playback was flushed. */
  onInterrupted: () => void;
  /** Servy decided to delegate to the brain. */
  onToolCall: (call: LiveFunctionCall) => void;
  /** Gemini cancelled in-flight tool calls (e.g. the user changed topic). */
  onToolCancellation: (ids: string[]) => void;
  /** ~per-chunk mic RMS [0..1] for the orb. */
  onMicLevel: (rms: number) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export interface LiveSession {
  /** Feed the brain's answer back so the model can speak it. */
  sendToolResponse: (call: LiveFunctionCall, output: string) => void;
  /** Inject a system note (e.g. "the user confirmed; it succeeded: …") so the model voices it. */
  sendSystemNote: (text: string) => void;
  /** Is audio currently playing (Servy talking)? */
  isSpeaking: () => boolean;
  /** Stop the model talking immediately (manual interrupt). */
  flushSpeaker: () => void;
  close: () => void;
}

const ASK_SERVY_DECLARATION = {
  name: 'ask_servy',
  description:
    'Ask the ServWave brain to look up CRM data or prepare an action and answer the user. ' +
    'Use this for ANY question or request about customers, leads, jobs, estimates, invoices, ' +
    'the schedule, money, or for creating/updating/scheduling anything. Pass the full user request.',
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The full user question or task, in their own words.' },
    },
    required: ['question'],
    additionalProperties: false,
  },
};

export interface StartLiveOptions {
  token: string;
  model: string;
  voiceName: string;
  systemInstruction: string;
  handlers: LiveSessionHandlers;
}

/**
 * Connect + start streaming. Resolves once the socket is established and the mic
 * is live; rejects if either fails (the caller falls back to the recorder path).
 */
export async function startLiveSession(opts: StartLiveOptions): Promise<LiveSession> {
  const { token, model, voiceName, systemInstruction, handlers } = opts;

  const speaker = new SpeakerQueue();
  let mic: MicStreamer | null = null;
  let closed = false;

  const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });

  let downChunks = 0;
  const handleMessage = (msg: LiveServerMessage) => {
    const tc = msg.toolCall;
    if (tc?.functionCalls?.length) {
      for (const call of tc.functionCalls) {
        if (call.name) {
          vlog(`⇩ toolCall ${call.name}`, call.args);
          handlers.onToolCall({ id: call.id, name: call.name, args: call.args ?? undefined });
        }
      }
    }
    const cancelIds = msg.toolCallCancellation?.ids;
    if (cancelIds?.length) {
      vlog('⇩ toolCallCancellation', cancelIds);
      handlers.onToolCancellation(cancelIds);
    }

    const sc = msg.serverContent;
    if (!sc) {
      // setupComplete and other non-content frames land here — log them once so
      // you can see the handshake finished even before any audio.
      if (msg.setupComplete) vlog('⇩ setupComplete (Gemini ready for audio)');
      return;
    }
    if (sc.interrupted) {
      vlog('⇩ interrupted (barge-in)');
      speaker.flush(); // barge-in: stop talking immediately
      handlers.onInterrupted();
    }
    if (sc.inputTranscription?.text) {
      vlog(`⇩ YOU said: "${sc.inputTranscription.text}"`);
      handlers.onUserFragment(sc.inputTranscription.text);
    }
    if (sc.outputTranscription?.text) {
      vlog(`⇩ SERVY says: "${sc.outputTranscription.text}"`);
      handlers.onAssistantFragment(sc.outputTranscription.text);
    }
    for (const part of sc.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data) {
        downChunks++;
        if (downChunks === 1 || downChunks % 50 === 0) vlog(`⇩ audio chunk #${downChunks} (Servy speaking)`);
        speaker.play(base64ToInt16(data));
      }
    }
    if (sc.turnComplete) vlog('⇩ turnComplete (Gemini auto-detected end of turn)');
    if (sc.turnComplete) handlers.onTurnComplete();
  };

  let session: Session;
  try {
    vlog(`live.connect → model=${model}, voice=${voiceName}`);
    session = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: [{ functionDeclarations: [ASK_SERVY_DECLARATION] }],
        contextWindowCompression: { slidingWindow: {} },
      },
      callbacks: {
        onopen: () => {
          vlog('✅ onopen — WebSocket to Gemini Live established');
          handlers.onOpen();
        },
        onmessage: handleMessage,
        onerror: (e: ErrorEvent) => {
          vwarn('onerror', e?.message || e);
          handlers.onError(e?.message || 'Voice connection error');
        },
        onclose: (e: CloseEvent) => {
          vwarn(`onclose code=${e?.code} reason="${e?.reason}"`);
          if (!closed) handlers.onClose();
        },
      },
    });
    vlog('live.connect resolved (socket opening)');
  } catch (err) {
    vwarn('live.connect THREW', err);
    speaker.close();
    throw err;
  }

  // Mic up: stream PCM16/16k chunks and surface a level for the orb.
  try {
    let upChunks = 0;
    let peakLevel = 0;
    mic = new MicStreamer((chunk) => {
      const level = rmsLevel(chunk);
      if (level > peakLevel) peakLevel = level;
      handlers.onMicLevel(level);
      tapSentChunk(chunk); // record exactly what we send → __servyMic.play()/.download()
      if (!closed) {
        upChunks++;
        // Log the level periodically. level=0.0000 forever → still silent capture
        // (hardware/permission); level rising when you speak → mic is working.
        if (upChunks === 1 || upChunks % 50 === 0) {
          vlog(`⇧ mic up — chunk #${upChunks}, level=${level.toFixed(4)} (peak ${peakLevel.toFixed(4)})`);
        }
        session.sendRealtimeInput({ audio: { data: int16ToBase64(chunk), mimeType: 'audio/pcm;rate=16000' } });
      }
    });
    await mic.start();
    vlog('✅ mic started (AudioWorklet capturing at native rate → 16 kHz)');
  } catch (err) {
    vwarn('mic.start() FAILED', err);
    closed = true;
    try {
      session.close();
    } catch {
      /* already closed */
    }
    speaker.close();
    throw err;
  }

  return {
    sendToolResponse: (call, output) => {
      if (closed) return;
      session.sendToolResponse({
        functionResponses: [{ id: call.id, name: call.name, response: { output }, willContinue: false }],
      });
    },
    sendSystemNote: (text) => {
      if (closed) return;
      session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: `(system) ${text}` }] }], turnComplete: true });
    },
    isSpeaking: () => speaker.playing,
    flushSpeaker: () => speaker.flush(),
    close: () => {
      if (closed) return;
      closed = true;
      mic?.stop();
      speaker.close();
      try {
        session.close();
      } catch {
        /* already closed */
      }
    },
  };
}
