/**
 * #2030 slice 5 — confirm once per version when editing a sent estimate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  needsMaterialEditConfirm,
  rememberMaterialEditConfirmed,
  materialEditPrompt,
} from './materialEditConfirm';

const ID = 'est-1';

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('when the first material edit after a send is confirmed', () => {
  it('asks the first time', () => {
    expect(needsMaterialEditConfirm('SENT', ID, 1)).toBe(true);
  });

  it('does not ask a second time — the link is already dead, and saying so again is noise', () => {
    rememberMaterialEditConfirmed(ID, 1);

    expect(needsMaterialEditConfirm('SENT', ID, 1)).toBe(false);
  });

  it('asks again after the next send, which bumps the version', () => {
    rememberMaterialEditConfirmed(ID, 1);

    expect(needsMaterialEditConfirm('SENT', ID, 2)).toBe(true);
  });

  it('never asks about a draft — nothing is out with a customer to break', () => {
    expect(needsMaterialEditConfirm('DRAFT', ID, 1)).toBe(false);
  });

  it('asks about a PENDING estimate — a signed document is the one most worth warning about', () => {
    expect(needsMaterialEditConfirm('PENDING', ID, 1)).toBe(true);
  });

  it('keeps one estimate\'s answer out of another\'s', () => {
    rememberMaterialEditConfirmed(ID, 1);

    expect(needsMaterialEditConfirm('SENT', 'est-2', 1)).toBe(true);
  });
});

describe('what the prompt says', () => {
  it('names the link invalidation', () => {
    expect(materialEditPrompt(false).description).toMatch(/link .* will stop working/i);
  });

  it('names the signature void when there is a signature to void', () => {
    expect(materialEditPrompt(true).description).toMatch(/signature .* voided/i);
  });

  it('omits it when there is none — warning about what cannot happen teaches people to dismiss warnings', () => {
    expect(materialEditPrompt(false).description).not.toMatch(/signature/i);
  });

  it('says the estimate keeps its number, because a correction is not a new document', () => {
    for (const hasSignature of [true, false]) {
      expect(materialEditPrompt(hasSignature).description).toMatch(/keeps its number/i);
    }
  });
});
