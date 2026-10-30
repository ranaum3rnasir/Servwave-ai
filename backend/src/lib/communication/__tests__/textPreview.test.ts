import { describe, it, expect } from 'vitest';
import { textAlertPreview, TEXT_PREVIEW_LENGTH } from '../textPreview';

/** The count a person would make: what they see as one character each. */
const seen = (text: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;

describe('the preview of an inbound text in a bell alert (S08.23)', () => {
  it('is the first 80 characters of the text, and says so in one constant', () => {
    expect(TEXT_PREVIEW_LENGTH).toBe(80);
    const preview = textAlertPreview('a'.repeat(200));
    expect(preview).toBe('a'.repeat(80));
  });

  it('keeps a text of 80 characters or fewer whole', () => {
    expect(textAlertPreview('Can you come by tomorrow?')).toBe('Can you come by tomorrow?');
    expect(textAlertPreview('b'.repeat(80))).toBe('b'.repeat(80));
  });

  it('counts what a person sees as one character, never cutting an emoji in half', () => {
    // Each of these is several code units (a surrogate pair, a joined family, a flag), and one character to the eye.
    const emoji = ['😀', '👨‍👩‍👧‍👦', '🇮🇱', '👍🏽'];
    const text = Array.from({ length: 100 }, (_, i) => emoji[i % emoji.length]).join('');
    const preview = textAlertPreview(text);
    expect(seen(preview)).toBe(80);
    expect(text.startsWith(preview)).toBe(true);
    // A cut in the middle of a pair would leave a lone surrogate behind.
    expect(preview).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it('counts a letter with combining accents as one character', () => {
    const accented = 'é'.repeat(100); // e + combining acute, a hundred times
    const preview = textAlertPreview(accented);
    expect(seen(preview)).toBe(80);
    expect(preview).toBe('é'.repeat(80));
    expect(preview.endsWith('́')).toBe(true);
  });

  it('collapses whitespace and newlines into single spaces, and trims, before it counts', () => {
    expect(textAlertPreview('  Gate code\n\n is   4412\t now \n')).toBe('Gate code is 4412 now');
    // The collapse comes first, so a text padded with blank lines still shows its first 80 characters of words.
    expect(textAlertPreview(`${'\n'.repeat(60)}${'w'.repeat(100)}`)).toBe('w'.repeat(80));
  });

  it('is empty for a text with no words, so the alert carries no preview line', () => {
    expect(textAlertPreview('')).toBe('');
    expect(textAlertPreview(' \n\t ')).toBe('');
  });

  it('leaves markup as plain characters; the bell prints text, not HTML', () => {
    expect(textAlertPreview('<img src=x onerror=alert(1)> hi')).toBe('<img src=x onerror=alert(1)> hi');
  });
});
