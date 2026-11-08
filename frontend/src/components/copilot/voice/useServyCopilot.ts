/**
 * useServyCopilot — the copilot orchestration hook (recorder-voice edition).
 *
 * Voice input is browser CAPTURE + server TRANSCRIPTION: the mic records one
 * utterance (silence-detected via vad.ts), the clip goes to the authed
 * `/api/copilot/transcribe` proxy where Gemini transcribes it, and the text
 * flows through the same conversation loop as typing. This replaced the
 * browser SpeechRecognition engine, which silently fails in many setups.
 * Replies are spoken with local SpeechSynthesis. The API key never reaches
 * the client. The tool bridge (reads = immediate, writes = hash-pinned
 * approval card) is unchanged — this hook just wires transport + state.
 *
 * Voice loop: record → transcribe → runConversationTurn → speak → record …
 * The next recording only starts after TTS finishes (echo guard).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppAbility } from '@/contexts/AbilityContext';
import type { AppAbility } from '@/lib/ability';
import { useCopilotStore } from '@/stores/copilotStore';
import { voiceReducer, type VoiceEvent } from './voiceState';
import { buildFunctionDeclarations } from '../tools/toolRegistry';
import { handleToolCall, commitAction, stripInternalIds } from '../tools/toolHandlers';
import { runConversationTurn } from '../tools/conversationLoop';
import {
  generateReply,
  transcribeAudio,
  mintLiveToken,
  createConversation,
  persistTurn,
  type GeminiContent,
} from '@/lib/copilot/api';
import { createVoiceSession, voiceRecordingSupported, type VoiceSession } from './recorder';
import { blobToWavBase64 } from './wav';
import { createSpeaker, type Speaker } from './speechSynthesis';
import { startLiveSession, type LiveSession, type LiveFunctionCall } from './liveSession';
import { vlog, vwarn } from './voiceLog';

export interface CopilotSessionApi {
  ensureConnected: () => Promise<boolean>;
  retry: () => Promise<void>;
  sendText: (text: string) => Promise<void>;
  startVoice: () => Promise<void>;
  stopVoice: () => void;
  stopSpeaking: () => void;
  confirmApproval: () => Promise<void>;
  cancelApproval: () => void;
  disconnect: () => void;
}

function generateError(e: unknown): string {
  const r = (e as { response?: { status?: number; data?: { error?: string } } })?.response;
  if (r?.status === 503) return "Servy isn't configured yet — an admin needs to add a GEMINI_API_KEY.";
  // 429 = our rate bucket OR the AI provider's quota — the server says which.
  if (r?.status === 429) return r.data?.error ?? "You're sending messages a bit fast. Give it a second and try again.";
  if (r?.status === 502) return r.data?.error ?? 'Servy could not respond just now. Please try again.';
  return "I couldn't reach Servy. Check your connection and try again.";
}

export function useServyCopilot(): CopilotSessionApi {
  const ability = useAppAbility();
  const abilityRef = useRef<AppAbility>(ability);
  abilityRef.current = ability;

  const store = useCopilotStore;
  const contentsRef = useRef<GeminiContent[]>([]);
  // ─── Gemini Live (primary voice transport) ───
  const liveRef = useRef<LiveSession | null>(null);
  const liveActiveRef = useRef(false);
  // Tool calls Gemini Live cancelled mid-flight — drop their results.
  const cancelledCallsRef = useRef<Set<string>>(new Set());
  // ─── Recorder (fallback voice transport when Live is unavailable) ───
  const sessionRef = useRef<VoiceSession | null>(null);
  // True while we intend the mic loop to keep recording turns. Cleared while
  // Servy is answering/speaking (echo guard) and on stop/disconnect.
  const wantListeningRef = useRef(false);
  // Re-entrancy guard: only one recordTurn loop at a time.
  const listeningRef = useRef(false);
  const speakerRef = useRef<Speaker | null>(null);
  const runningRef = useRef(false);
  const creatingConvoRef = useRef(false);

  const dispatchVoice = useCallback(
    (event: VoiceEvent) => {
      const cur = store.getState().voiceState;
      store.getState().setVoiceState(voiceReducer(cur, event));
    },
    [store],
  );

  const ensureSpeaker = useCallback((): Speaker => {
    if (!speakerRef.current) speakerRef.current = createSpeaker();
    return speakerRef.current;
  }, []);

  // Crude EN/HE/ES hint from the browser, used for both STT and TTS.
  const localeLang = useCallback((): string => {
    const l = (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase();
    if (l.startsWith('he')) return 'he-IL';
    if (l.startsWith('es')) return 'es-ES';
    return 'en-US';
  }, []);

  // ─── Persistence (best-effort; mirrors the prior transport) ───
  const ensureConversation = useCallback(async (): Promise<string | null> => {
    const existing = store.getState().activeConversationId;
    if (existing) return existing;
    if (creatingConvoRef.current) return null;
    creatingConvoRef.current = true;
    try {
      const convo = await createConversation();
      store.getState().setActiveConversationId(convo.id);
      return convo.id;
    } catch {
      return null;
    } finally {
      creatingConvoRef.current = false;
    }
  }, [store]);

  const persist = useCallback(
    async (role: 'USER' | 'ASSISTANT', modality: 'TEXT' | 'VOICE', content: string, turnId?: string) => {
      try {
        const cid = await ensureConversation();
        if (!cid) return;
        const res = await persistTurn({ conversation_id: cid, role, modality, content });
        if (turnId) {
          if (res.fallback) store.getState().updateTurn(turnId, { text: res.message.content, label: 'fallback' });
          else store.getState().updateTurn(turnId, { messageId: res.message.id });
        }
      } catch {
        /* persistence is best-effort */
      }
    },
    [ensureConversation, store],
  );

  // ─── Speaking (voice mode only) with the echo guard ───
  // The record loop lives further down (it needs runTurn); this ref breaks the
  // cycle so speak()/runTurn can resume listening after the reply.
  const listenLoopRef = useRef<() => void>(() => {});

  const resumeListening = useCallback(() => {
    const s = store.getState();
    if (s.mode === 'voice' && s.micActive && !s.pendingApproval) {
      wantListeningRef.current = true;
      listenLoopRef.current();
    }
  }, [store]);

  const speak = useCallback(
    (text: string) => {
      if (store.getState().mode !== 'voice' || !text.trim()) {
        resumeListening();
        return;
      }
      const sp = ensureSpeaker();
      if (!sp.supported) {
        resumeListening();
        return;
      }
      // Pause recording so the mic never hears Servy's own voice.
      wantListeningRef.current = false;
      sessionRef.current?.cancelTurn();
      sp.speak(stripInternalIds(text), {
        lang: localeLang(),
        onStart: () => dispatchVoice({ type: 'MODEL_SPEAKING' }),
        onEnd: () => {
          dispatchVoice({ type: 'TURN_COMPLETE' });
          resumeListening();
        },
      });
    },
    [dispatchVoice, ensureSpeaker, localeLang, resumeListening, store],
  );

  // ─── One turn: generate ↔ tools → display + speak ───
  const runTurn = useCallback(
    async (userText: string, opts: { speak: boolean }) => {
      if (runningRef.current) return;
      runningRef.current = true;
      store.getState().setStatusText('Thinking…');
      contentsRef.current.push({ role: 'user', parts: [{ text: userText }] });
      try {
        const tools = [{ functionDeclarations: buildFunctionDeclarations(abilityRef.current) }];
        const result = await runConversationTurn(contentsRef.current, tools, {
          // Send only the recent window to keep payloads + cost bounded; the full
          // history stays in contentsRef for local continuity.
          generate: (contents, tls) => generateReply(contents.slice(-80), tls, localeLang()),
          executeTool: (name, args) => handleToolCall(name, args),
          onPhase: (phase) => {
            if (phase === 'reading' || phase === 'preparing') dispatchVoice({ type: 'TOOL_RUNNING' });
            store.getState().setStatusText(
              phase === 'reading' ? 'Checking CRM data…' : phase === 'preparing' ? 'Preparing…' : 'Thinking…',
            );
          },
        });

        if (result.pending) {
          store.getState().setPendingApproval({ action: result.pending.action, callId: result.pending.call.id });
        }

        const text = result.assistantText || (result.pending ? '' : "Sorry — I couldn't complete that.");
        if (text.trim()) {
          const aid = store.getState().addTurn({ role: 'assistant', text, modality: store.getState().mode });
          void persist('ASSISTANT', store.getState().mode === 'voice' ? 'VOICE' : 'TEXT', text, aid);
          if (opts.speak) speak(text);
          else dispatchVoice({ type: 'TURN_COMPLETE' });
        } else {
          dispatchVoice({ type: 'TURN_COMPLETE' });
          if (!result.pending) resumeListening();
        }
      } catch (e) {
        store.getState().setError(generateError(e));
        dispatchVoice({ type: 'ERROR' });
        resumeListening();
      } finally {
        runningRef.current = false;
        store.getState().setStatusText(null);
      }
    },
    [dispatchVoice, localeLang, persist, resumeListening, speak, store],
  );

  // ─── Gemini Live: the ask_servy delegate ───
  // The Live model is only the voice. For any CRM question/action it calls
  // ask_servy, which we route through the SAME brain loop as text (codex
  // /generate + the CASL-gated tool bridge + approval cards). The answer goes
  // back via sendToolResponse so the model speaks it. Writes still raise an
  // approval card; the confirmed outcome is voiced later via a system note.
  const runAskServy = useCallback(
    async (call: LiveFunctionCall) => {
      if (runningRef.current) return;
      runningRef.current = true;
      dispatchVoice({ type: 'TOOL_RUNNING' });
      store.getState().setStatusText('Thinking…');
      const live = liveRef.current;
      const question =
        typeof call.args?.question === 'string' && call.args.question.trim()
          ? call.args.question.trim()
          : store.getState().interim.user.trim();
      contentsRef.current.push({ role: 'user', parts: [{ text: question || '(the user spoke)' }] });
      try {
        const tools = [{ functionDeclarations: buildFunctionDeclarations(abilityRef.current) }];
        const result = await runConversationTurn(contentsRef.current, tools, {
          generate: (contents, tls) => generateReply(contents.slice(-80), tls, localeLang()),
          executeTool: (name, args) => handleToolCall(name, args),
          onPhase: (phase) =>
            store.getState().setStatusText(
              phase === 'reading' ? 'Checking CRM data…' : phase === 'preparing' ? 'Preparing…' : 'Thinking…',
            ),
        });

        // Gemini cancelled this call mid-flight (the user moved on) — drop it.
        if (call.id && cancelledCallsRef.current.has(call.id)) {
          cancelledCallsRef.current.delete(call.id);
          return;
        }

        if (result.pending) {
          store.getState().setPendingApproval({ action: result.pending.action, callId: call.id });
        }
        const answer = result.assistantText || (result.pending ? 'Done.' : "Sorry — I couldn't complete that.");
        live?.sendToolResponse(call, stripInternalIds(answer) || 'Done.');
      } catch (e) {
        store.getState().setError(generateError(e));
        dispatchVoice({ type: 'ERROR' });
        live?.sendToolResponse(call, "Sorry — I couldn't complete that right now.");
      } finally {
        runningRef.current = false;
        store.getState().setStatusText(null);
      }
    },
    [dispatchVoice, localeLang, store],
  );

  // Commit the live transcription bubbles (user + assistant) to the transcript
  // and persist them, once a spoken exchange completes.
  const commitLiveTurns = useCallback(() => {
    const { interim } = store.getState();
    const u = interim.user.trim();
    const a = interim.assistant.trim();
    if (u) {
      store.getState().addTurn({ role: 'user', text: u, modality: 'voice' });
      void persist('USER', 'VOICE', u);
    }
    if (a) {
      const aid = store.getState().addTurn({ role: 'assistant', text: a, modality: 'voice' });
      void persist('ASSISTANT', 'VOICE', a, aid);
    }
    store.getState().clearInterim();
    dispatchVoice({ type: 'TURN_COMPLETE' });
  }, [dispatchVoice, persist, store]);

  // ─── Public API ───
  const ensureConnected = useCallback(async (): Promise<boolean> => {
    if (store.getState().connection !== 'connected') {
      store.getState().setConnection('connected');
      dispatchVoice({ type: 'CONNECTED' });
    }
    return true;
  }, [dispatchVoice, store]);

  const sendText = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      store.getState().setMode('text');
      store.getState().setError(null);
      await ensureConnected();
      store.getState().addTurn({ role: 'user', text: t, modality: 'text' });
      void persist('USER', 'TEXT', t);
      await runTurn(t, { speak: false });
    },
    [ensureConnected, persist, runTurn, store],
  );

  // ─── The voice loop: record one utterance → transcribe → run the turn ───
  // Continuation is event-driven: after Servy speaks, TTS onEnd → resumeListening
  // → next listenOnce. A no-speech turn just re-arms directly.
  const listenOnce = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || listeningRef.current || !wantListeningRef.current) return;
    listeningRef.current = true;
    try {
      while (wantListeningRef.current && store.getState().mode === 'voice') {
        dispatchVoice({ type: 'MIC_ON' }); // → listening
        const blob = await session.recordTurn();
        store.getState().setMicLevel(0);
        if (!wantListeningRef.current) return;
        if (!blob) continue; // silence/no speech — keep listening

        // We have an utterance: pause the loop while we answer.
        wantListeningRef.current = false;
        dispatchVoice({ type: 'TOOL_RUNNING' }); // → thinking
        store.getState().setStatusText('Transcribing…');
        let text = '';
        try {
          const wavBase64 = await blobToWavBase64(blob);
          text = await transcribeAudio(wavBase64, 'audio/wav', localeLang());
        } catch (e) {
          console.warn('[Servy] transcription failed:', e);
          store.getState().setStatusText(null);
          store.getState().setError(generateError(e));
          dispatchVoice({ type: 'ERROR' });
          wantListeningRef.current = true;
          continue; // mic stays on; user can try again
        }
        store.getState().setStatusText(null);

        if (!text) {
          // Heard something but nothing intelligible — quietly keep listening.
          wantListeningRef.current = true;
          continue;
        }

        store.getState().setError(null);
        store.getState().addTurn({ role: 'user', text, modality: 'voice' });
        void persist('USER', 'VOICE', text);
        await runTurn(text, { speak: true });
        // runTurn → speak() → TTS onEnd → resumeListening() re-enters the loop.
        return;
      }
    } finally {
      listeningRef.current = false;
    }
  }, [dispatchVoice, localeLang, persist, runTurn, store]);
  listenLoopRef.current = () => void listenOnce();

  // Fallback voice path: browser records an utterance → server transcribes via
  // Gemini → brain → browser SpeechSynthesis speaks. Used only when Gemini Live
  // is unavailable (voice not configured, Live denied, or no mic worklet).
  const startVoiceRecorder = useCallback(async () => {
    store.getState().setError(null);
    if (!voiceRecordingSupported()) {
      store.getState().setError("This browser can't record audio — you can still type to Servy.");
      store.getState().setMode('text');
      return;
    }
    store.getState().setMode('voice');
    ensureSpeaker(); // create within the user gesture
    await ensureConnected();

    if (!sessionRef.current) {
      sessionRef.current = createVoiceSession({
        onLevel: (rms) => store.getState().setMicLevel(rms),
        onSpeechStart: () => dispatchVoice({ type: 'USER_SPEAKING' }),
      });
    }
    try {
      await sessionRef.current.acquire();
    } catch (e) {
      console.warn('[Servy] mic acquire failed:', e);
      sessionRef.current = null;
      store.getState().setError('Microphone blocked — allow mic access, or type to Servy.');
      store.getState().setMode('text');
      dispatchVoice({ type: 'MIC_OFF' });
      return;
    }

    store.getState().setMicActive(true);
    dispatchVoice({ type: 'MIC_ON' });
    wantListeningRef.current = true;
    void listenOnce();
  }, [dispatchVoice, ensureConnected, ensureSpeaker, listenOnce, store]);

  const stopVoice = useCallback(() => {
    if (liveActiveRef.current) {
      liveActiveRef.current = false;
      liveRef.current?.close();
      liveRef.current = null;
    }
    wantListeningRef.current = false;
    sessionRef.current?.release();
    sessionRef.current = null;
    speakerRef.current?.cancel();
    store.getState().clearInterim();
    store.getState().setMicLevel(0);
    store.getState().setMicActive(false);
    dispatchVoice({ type: 'MIC_OFF' });
  }, [dispatchVoice, store]);

  // Primary voice path: real-time Gemini Live (WebSocket, native audio, barge-in).
  // Mint an ephemeral token, connect directly to Live, and delegate every CRM
  // question/action to the brain via ask_servy. Any failure (voice not
  // configured / Live denied / mic) falls back to the recorder path so the user
  // always has a working voice.
  const startVoice = useCallback(async () => {
    store.getState().setError(null);
    store.getState().setMode('voice');
    cancelledCallsRef.current.clear();
    // Show the orb "connecting" while we mint a token + open the Live socket;
    // onOpen flips it to listening. (The recorder fallback connects itself.)
    store.getState().setConnection('connecting');
    dispatchVoice({ type: 'CONNECT' });

    try {
      vlog('startVoice → minting Live token from /api/copilot/token …');
      const recent = store.getState().transcript.slice(-12).map((t) => ({ role: t.role, text: t.text }));
      const tok = await mintLiveToken(recent, localeLang());
      vlog(`token minted ✓ (model=${tok.model}, voice=${tok.voiceName}) — starting Live session`);
      const live = await startLiveSession({
        token: tok.token,
        model: tok.model,
        voiceName: tok.voiceName,
        systemInstruction: tok.systemInstruction,
        handlers: {
          onOpen: () => {
            store.getState().setConnection('connected');
            dispatchVoice({ type: 'CONNECTED' });
          },
          onUserFragment: (text) => {
            store.getState().appendInterim('user', text);
            dispatchVoice({ type: 'USER_SPEAKING' });
          },
          onAssistantFragment: (text) => {
            store.getState().appendInterim('assistant', text);
            dispatchVoice({ type: 'MODEL_SPEAKING' });
          },
          onTurnComplete: () => commitLiveTurns(),
          onInterrupted: () => dispatchVoice({ type: 'INTERRUPTED' }),
          onToolCall: (call) => void runAskServy(call),
          onToolCancellation: (ids) => ids.forEach((id) => cancelledCallsRef.current.add(id)),
          onMicLevel: (rms) => store.getState().setMicLevel(rms),
          onError: (msg) => {
            store.getState().setError(msg);
            dispatchVoice({ type: 'ERROR' });
          },
          onClose: () => {
            if (liveActiveRef.current) stopVoice();
          },
        },
      });
      liveRef.current = live;
      liveActiveRef.current = true;
      store.getState().setMicActive(true);
      dispatchVoice({ type: 'MIC_ON' });
      vlog('✅ LIVE MODE ACTIVE — talk now (watch for "YOU said" lines)');
      return;
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      vwarn(`Gemini Live FAILED (status=${status ?? 'n/a'}) — FALLING BACK to the old recorder path`, e);
    }

    vlog('↩ recorder fallback active (record→transcribe→speak; no live transcription / no server VAD)');
    await startVoiceRecorder();
  }, [commitLiveTurns, dispatchVoice, localeLang, runAskServy, startVoiceRecorder, stopVoice, store]);

  const stopSpeaking = useCallback(() => {
    if (liveActiveRef.current) liveRef.current?.flushSpeaker();
    else speakerRef.current?.cancel();
    dispatchVoice({ type: 'INTERRUPTED' });
  }, [dispatchVoice]);

  const disconnect = useCallback(() => {
    liveActiveRef.current = false;
    liveRef.current?.close();
    liveRef.current = null;
    wantListeningRef.current = false;
    sessionRef.current?.release();
    sessionRef.current = null;
    speakerRef.current?.cancel();
    store.getState().setMicLevel(0);
    store.getState().setMicActive(false);
    store.getState().setConnection('disconnected');
    dispatchVoice({ type: 'DISCONNECT' });
  }, [dispatchVoice, store]);

  const retry = useCallback(async () => {
    store.getState().setError(null);
    await ensureConnected();
  }, [ensureConnected, store]);

  const pushSystemNote = useCallback((text: string) => {
    contentsRef.current.push({ role: 'user', parts: [{ text: `(system) ${text}` }] });
  }, []);

  const confirmApproval = useCallback(async () => {
    const pa = store.getState().pendingApproval;
    if (!pa) return;
    // Clear the approval IMMEDIATELY (zustand is synchronous) so a double-click
    // sees null and the action runs exactly once.
    store.getState().setPendingApproval(null);
    store.getState().setStatusText('Saving…');
    const result = await commitAction(pa.action);
    const text = result.ok ? `✅ ${result.resultText}` : `⚠️ ${result.error}`;
    const note = result.ok
      ? `The user confirmed and it succeeded: ${result.resultText}.`
      : `The action failed: ${result.error}. Nothing was changed.`;
    pushSystemNote(note); // keep the brain's context informed
    store.getState().setStatusText(null);
    if (liveActiveRef.current) {
      // Live re-voices the outcome from the system note (its transcription
      // renders the bubble), so we don't add a duplicate turn here.
      liveRef.current?.sendSystemNote(note);
    } else {
      const aid = store.getState().addTurn({ role: 'assistant', text, modality: store.getState().mode });
      void persist('ASSISTANT', store.getState().mode === 'voice' ? 'VOICE' : 'TEXT', text, aid);
      if (store.getState().mode === 'voice') speak(text);
    }
  }, [persist, pushSystemNote, speak, store]);

  const cancelApproval = useCallback(() => {
    store.getState().setPendingApproval(null);
    const note = 'The user cancelled. Nothing was saved.';
    pushSystemNote(note);
    if (liveActiveRef.current) {
      liveRef.current?.sendSystemNote(note);
    } else {
      store.getState().addTurn({ role: 'assistant', text: 'Okay — cancelled. Nothing was saved.', modality: store.getState().mode });
      if (store.getState().mode === 'voice') speak('Okay — cancelled. Nothing was saved.');
    }
  }, [pushSystemNote, speak, store]);

  // If the conversation is reset (activeConversationId → null, e.g. a future
  // "new chat"), drop the Gemini context too so the model doesn't keep
  // continuing a thread the user just wiped. Version-agnostic (doesn't rely on
  // the subscribe prevState arg).
  const lastConvoRef = useRef<string | null>(null);
  useEffect(
    () =>
      useCopilotStore.subscribe((s) => {
        if (lastConvoRef.current && !s.activeConversationId) contentsRef.current = [];
        lastConvoRef.current = s.activeConversationId;
      }),
    [],
  );

  // Tear down on unmount.
  useEffect(() => () => disconnect(), [disconnect]);

  return useMemo<CopilotSessionApi>(
    () => ({
      ensureConnected,
      retry,
      sendText,
      startVoice,
      stopVoice,
      stopSpeaking,
      confirmApproval,
      cancelApproval,
      disconnect,
    }),
    [ensureConnected, retry, sendText, startVoice, stopVoice, stopSpeaking, confirmApproval, cancelApproval, disconnect],
  );
}
