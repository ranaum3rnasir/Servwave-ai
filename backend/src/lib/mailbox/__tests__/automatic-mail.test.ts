import { describe, it, expect } from 'vitest';
import { isAutomaticMail } from '../automatic-mail';

/**
 * PRD 10, S10.18: what counts as automatic mail (an out-of-office reply, a bounce, a mailing-list or bulk message). Such mail goes
 * to Needs review as automatic mail instead of the inbox. Pure: the sender and the headers are all it reads.
 */

const FROM = 'Pat Payer <pat@example.com>';
const auto = (headers: Record<string, string> | null, from = FROM) => isAutomaticMail({ from, headers });

describe('isAutomaticMail', () => {
  it('is false for an ordinary message, with or without headers', () => {
    expect(auto({ 'Authentication-Results': 'amazonses.com; dmarc=pass', Subject: 'hi' })).toBe(false);
    expect(auto(null)).toBe(false);
    expect(auto({})).toBe(false);
  });

  describe('Auto-Submitted', () => {
    it.each(['auto-replied', 'auto-generated', 'auto-notified', 'Auto-Replied', ' auto-generated ', 'auto-replied; owner-email="a@b.c"'])(
      'is true for %j', (value) => expect(auto({ 'Auto-Submitted': value })).toBe(true),
    );
    it.each(['no', 'No', ' no ', 'NO'])('is false for %j (the header says a person wrote it)', (value) => expect(auto({ 'Auto-Submitted': value })).toBe(false));
    it('reads the header whatever its case', () => expect(auto({ 'auto-submitted': 'auto-replied' })).toBe(true));
    it('treats a header with no value as automatic: it is present and is not "no"', () => expect(auto({ 'Auto-Submitted': '' })).toBe(true));
  });

  describe('Precedence', () => {
    it.each(['bulk', 'junk', 'list', 'auto_reply', 'auto-reply', 'Auto_Reply', ' BULK '])('is true for %j', (value) => expect(auto({ Precedence: value })).toBe(true));
    it.each(['first-class', 'special-delivery', 'normal', ''])('is false for %j', (value) => expect(auto({ Precedence: value })).toBe(false));
  });

  describe('an empty sender (a bounce)', () => {
    it.each(['', '   ', '<>', 'Mail Delivery <>', 'no address here'])('is true when the From is %j', (from) => expect(auto({}, from)).toBe(true));
    it('is true when the return path is empty, whatever the From says', () => {
      expect(auto({ 'Return-Path': '<>' })).toBe(true);
      expect(auto({ 'return-path': ' <> ' })).toBe(true);
    });
    it('is false for a real return path', () => expect(auto({ 'Return-Path': '<pat@example.com>' })).toBe(false));
  });
});
