import { describe, expect, it } from 'vitest';

import {
  overlayPresentation,
  overlayWidthClass,
  type OverlayIntent,
  type OverlayWidthClass,
} from '@/ui-kit/lib/overlayPresentation';

describe('overlayWidthClass', () => {
  it('is phone below md, whatever the height', () => {
    expect(overlayWidthClass({ belowMd: true, shortHeight: false })).toBe('phone');
    expect(overlayWidthClass({ belowMd: true, shortHeight: true })).toBe('phone');
  });
  it('is short at md and up when the height is short (a phone held sideways)', () => {
    expect(overlayWidthClass({ belowMd: false, shortHeight: true })).toBe('short');
  });
  it('is wide otherwise', () => {
    expect(overlayWidthClass({ belowMd: false, shortHeight: false })).toBe('wide');
  });
});

describe('overlayPresentation (width class x intent)', () => {
  const table: Array<[OverlayWidthClass, OverlayIntent, string]> = [
    ['phone', 'form', 'fullscreen'],
    ['phone', 'content', 'fullscreen'],
    ['phone', 'choice', 'bottom-sheet'],
    ['short', 'form', 'fullscreen'],
    ['short', 'content', 'fullscreen'],
    ['short', 'choice', 'card'],
    ['wide', 'form', 'card'],
    ['wide', 'content', 'card'],
    ['wide', 'choice', 'card'],
  ];
  it.each(table)('%s + %s -> %s', (width, intent, expected) => {
    expect(overlayPresentation(width, intent)).toBe(expected);
  });
});
