/**
 * The voice recorder session: one getUserMedia stream reused across turns,
 * an AnalyserNode driving both the silence auto-stop (vad.ts) and the live
 * level for the orb animation, and a MediaRecorder per turn.
 *
 * Replaces the browser SpeechRecognition engine: recording is pure browser
 * capture (works in EVERY modern browser, no Google speech service), and the
 * actual transcription happens server-side via Gemini.
 */
import { createVadTracker, DEFAULT_VAD, type VadConfig } from './vad';

export interface VoiceSessionHandlers {
  /** ~12 Hz RMS level [0..~0.5] while recording — drive the orb with it. */
  onLevel?: (rms: number) => void;
  /** Fired once per turn when speech is first detected. */
  onSpeechStart?: () => void;
}

export interface VoiceSession {
  /** Ask for the mic (user gesture!). Throws on deny/unavailable. */
  acquire: () => Promise<void>;
  /**
   * Record one utterance. Resolves with the audio blob once the user spoke and
   * went quiet (or hit the cap), or null if nothing was said / it was aborted.
   */
  recordTurn: (config?: VadConfig) => Promise<Blob | null>;
  /** Abort just the in-flight turn (resolves it with null); the mic stays. */
  cancelTurn: () => void;
  /** Abort any in-flight turn (resolves it with null) and release the mic. */
  release: () => void;
  isActive: () => boolean;
}

export function voiceRecordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof window !== 'undefined' &&
    'MediaRecorder' in window
  );
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return undefined;
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

export function createVoiceSession(handlers: VoiceSessionHandlers = {}): VoiceSession {
  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let abortTurn: (() => void) | null = null;
  let released = false;

  async function acquire(): Promise<void> {
    if (stream) return;
    released = false;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const Ctx: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new Ctx();
    // Some browsers hand back a suspended context outside a direct gesture.
    if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => undefined);
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
  }

  function rmsNow(buf: Float32Array<ArrayBuffer>): number {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] ?? 0;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  function recordTurn(config: VadConfig = DEFAULT_VAD): Promise<Blob | null> {
    if (!stream || !analyser || released) return Promise.resolve(null);

    return new Promise<Blob | null>((resolve) => {
      const mimeType = pickMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream!, mimeType ? { mimeType } : undefined);
      } catch {
        resolve(null);
        return;
      }

      const chunks: BlobPart[] = [];
      const buf = new Float32Array(new ArrayBuffer(analyser!.fftSize * 4));
      const vad = createVadTracker(performance.now(), config);
      let spokeFired = false;
      let settled = false;

      /** Abort/discard/error path — always resolves null. */
      const discard = () => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        abortTurn = null;
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch {
          /* noop */
        }
        resolve(null);
      };

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.onerror = () => discard();

      abortTurn = () => discard();

      const timer = setInterval(() => {
        const verdict = vad.update(rmsNow(buf), performance.now());
        handlers.onLevel?.(rmsNow(buf));
        if (verdict === 'speaking' && !spokeFired) {
          spokeFired = true;
          handlers.onSpeechStart?.();
        } else if (verdict === 'discard') {
          discard();
        } else if (verdict === 'stop') {
          // Speech ended — hand the collected audio back after the flush.
          const type = recorder.mimeType || mimeType || 'audio/webm';
          if (settled) return;
          settled = true;
          clearInterval(timer);
          abortTurn = null;
          recorder.onstop = () => {
            setTimeout(() => resolve(chunks.length ? new Blob(chunks, { type }) : null), 0);
          };
          try {
            recorder.stop();
          } catch {
            resolve(chunks.length ? new Blob(chunks, { type }) : null);
          }
        }
      }, 80);

      try {
        recorder.start(250); // chunk every 250ms so stop() flushes fast
      } catch {
        discard();
      }
    });
  }

  function release(): void {
    released = true;
    abortTurn?.();
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    analyser = null;
    if (audioCtx) {
      void audioCtx.close().catch(() => undefined);
      audioCtx = null;
    }
  }

  return {
    acquire,
    recordTurn,
    cancelTurn: () => abortTurn?.(),
    release,
    isActive: () => stream !== null,
  };
}
