import { describe, it, expect } from 'vitest';
import { cleanTranscript } from '../services/copilot/gemini-generate';

// The STT model is told to reply "NONE" for silence, but smaller models
// sometimes refuse in prose instead — none of that may become a "user said".
describe('cleanTranscript', () => {
  it('passes real transcripts through', () => {
    expect(cleanTranscript('Create a lead for Jane Doe')).toBe('Create a lead for Jane Doe');
    expect(cleanTranscript('  hello there  ')).toBe('hello there');
  });

  it('maps the NONE sentinel to empty', () => {
    expect(cleanTranscript('NONE')).toBe('');
    expect(cleanTranscript('none.')).toBe('');
    expect(cleanTranscript('"NONE"')).toBe('');
  });

  it('maps refusal prose to empty', () => {
    expect(cleanTranscript("I'm sorry, but I cannot provide a transcript for this audio.")).toBe('');
    expect(cleanTranscript('I cannot transcribe this audio.')).toBe('');
    expect(cleanTranscript('There is no speech in this audio.')).toBe('');
    expect(cleanTranscript('No intelligible speech detected.')).toBe('');
  });

  it('strips wrapping quotes from real transcripts', () => {
    expect(cleanTranscript('"How many jobs today?"')).toBe('How many jobs today?');
  });

  it('keeps sentences that merely contain refusal-ish words mid-text', () => {
    expect(cleanTranscript('Tell the customer I cannot come today')).toBe('Tell the customer I cannot come today');
  });
});
