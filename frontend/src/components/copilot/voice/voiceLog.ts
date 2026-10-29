/**
 * Servy voice debug tracer. Logs each stage of the Gemini Live pipeline to the
 * browser console with a bright prefix so you can watch where the chain stops:
 *
 *   mic click → mint token → live.connect → onopen → mic PCM streaming up →
 *   inputTranscription (you) → ask_servy → audio chunks down → turnComplete
 *
 * ON by default in the browser. Silence it from the DevTools console with:
 *   localStorage.setItem('servy_voice_debug', 'off')   // then refresh
 * Re-enable with:
 *   localStorage.removeItem('servy_voice_debug')
 */
function enabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('servy_voice_debug') !== 'off';
  } catch {
    return true;
  }
}

const STYLE = 'color:#fff;background:#5B6DFF;font-weight:bold;padding:1px 5px;border-radius:4px';

export function vlog(stage: string, ...args: unknown[]): void {
  if (!enabled()) return;
  const t = new Date().toISOString().slice(11, 23);
  // eslint-disable-next-line no-console
  console.info(`%c🎙 Servy%c ${t} ${stage}`, STYLE, 'color:#5B6DFF', ...args);
}

export function vwarn(stage: string, ...args: unknown[]): void {
  if (!enabled()) return;
  // eslint-disable-next-line no-console
  console.warn(`🎙 Servy ⚠ ${stage}`, ...args);
}
