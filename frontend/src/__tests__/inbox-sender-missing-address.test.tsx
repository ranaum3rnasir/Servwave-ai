// A sent row whose `from` carries no address at all.
//
// `Email.from` was typed `{ name: string | null; email: string }`, but the
// column is JSON and the data does not honour that: staging holds a row with
// `from = {}`. `senderLabel` then threw on `from.email.trim()` BEFORE its own
// 'Unknown sender' fallback could be reached, and because the list is one
// `.map` behind one error boundary, that single row blanked the whole Inbox -
// Sent, and any search that touched it.
//
// This is the address half of the hazard #1373 fixed for the name half. The
// lesson there was that a display field can be absent in real data; the type
// said otherwise for the address and was believed.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { senderLabel, type Email } from '@/lib/api/communication-shared/email';

/** The shapes real rows actually take, including ones the old type forbade. */
const NAMELESS = { name: null, email: 'someone@example.com' };
const ADDRESSLESS = { name: 'Only A Name', email: undefined };
const EMPTY = {}; // exactly what staging row 0709c447 holds
const BLANK = { name: '   ', email: '   ' };

describe('senderLabel is total', () => {
  it('prefers the display name', () => {
    expect(senderLabel({ name: 'Dana Ops', email: 'dana@example.com' })).toBe('Dana Ops');
  });

  it('falls back to the address when there is no name', () => {
    expect(senderLabel(NAMELESS)).toBe('someone@example.com');
  });

  it('falls back to the name when there is no address', () => {
    expect(senderLabel(ADDRESSLESS as Email['from'])).toBe('Only A Name');
  });

  it('does not throw on a from with neither field - the real staging row', () => {
    expect(() => senderLabel(EMPTY as Email['from'])).not.toThrow();
    expect(senderLabel(EMPTY as Email['from'])).toBe('Unknown sender');
  });

  it('treats whitespace-only values as absent rather than rendering blanks', () => {
    expect(senderLabel(BLANK as Email['from'])).toBe('Unknown sender');
  });

  it('survives from being null or undefined outright', () => {
    // The mapper passes `e.from` straight through from the database, so a null
    // column reaches this function unmodified.
    expect(senderLabel(null as unknown as Email['from'])).toBe('Unknown sender');
    expect(senderLabel(undefined as unknown as Email['from'])).toBe('Unknown sender');
  });
});

describe('the label is safe to render', () => {
  it('renders the fallback rather than the string "undefined"', () => {
    // Interpolating a missing address used to put the literal text
    // "undefined" in front of a user; the fallback has to be a real word.
    render(<span>{senderLabel(EMPTY as Email['from'])}</span>);

    expect(screen.getByText('Unknown sender')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });
});
