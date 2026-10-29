import { describe, it, expect } from 'vitest';
import { createRateLimiter, rateKey } from '../services/copilot/rate-limit';
import { detectContradiction, SAFE_FALLBACK } from '../services/copilot/safety';
import { buildSystemInstruction } from '../services/copilot/persona';
import { listCapabilities, getCapability } from '../services/copilot/capability-registry';

describe('copilot rate-limit (token bucket)', () => {
  it('allows up to capacity, then blocks', () => {
    const rl = createRateLimiter({ capacity: 3, refillPerMin: 0 });
    const key = rateKey('org', 'user');
    expect(rl.tryConsume(key, 0).allowed).toBe(true);
    expect(rl.tryConsume(key, 0).allowed).toBe(true);
    expect(rl.tryConsume(key, 0).allowed).toBe(true);
    const blocked = rl.tryConsume(key, 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it('refills over time', () => {
    const rl = createRateLimiter({ capacity: 1, refillPerMin: 60 }); // 1 token/sec
    const key = rateKey('o', 'u');
    expect(rl.tryConsume(key, 0).allowed).toBe(true);
    expect(rl.tryConsume(key, 0).allowed).toBe(false);
    // 1 second later, one token has refilled
    expect(rl.tryConsume(key, 1000).allowed).toBe(true);
  });

  it('scopes buckets per key (one user cannot exhaust another)', () => {
    const rl = createRateLimiter({ capacity: 1, refillPerMin: 0 });
    expect(rl.tryConsume(rateKey('org', 'a'), 0).allowed).toBe(true);
    expect(rl.tryConsume(rateKey('org', 'a'), 0).allowed).toBe(false);
    // Different user — still has a full bucket.
    expect(rl.tryConsume(rateKey('org', 'b'), 0).allowed).toBe(true);
  });
});

describe('copilot safety (contradiction detector EN/HE/ES)', () => {
  it('trips on English "sent" claims', () => {
    expect(detectContradiction("I've sent the email to the customer.").tripped).toBe(true);
    expect(detectContradiction('The message was sent.').tripped).toBe(true);
    expect(detectContradiction('I texted them the update.').tripped).toBe(true);
    expect(detectContradiction("I've sent the invoice email to the customer.").tripped).toBe(true);
    expect(detectContradiction("I've sent a reminder text.").tripped).toBe(true);
  });

  it('does NOT trip on sanctioned estimate-send claims (approval-carded system email)', () => {
    expect(detectContradiction("I've sent the estimate to the customer.").tripped).toBe(false);
    expect(detectContradiction('I sent estimate E00012.').tripped).toBe(false);
  });

  it('trips on Hebrew send claims', () => {
    expect(detectContradiction('שלחתי את המייל ללקוח').tripped).toBe(true);
    expect(detectContradiction('ההודעה נשלחה בהצלחה').tripped).toBe(true);
  });

  it('trips on Spanish send claims', () => {
    expect(detectContradiction('He enviado el correo al cliente.').tripped).toBe(true);
    expect(detectContradiction('El mensaje fue enviado.').tripped).toBe(true);
  });

  it('trips on delete claims', () => {
    expect(detectContradiction("I've deleted the lead for you.").tripped).toBe(true);
    expect(detectContradiction('מחקתי את הרשומה').tripped).toBe(true);
    expect(detectContradiction('He eliminado el registro.').tripped).toBe(true);
  });

  it('does NOT trip on legitimate supported actions or drafts', () => {
    expect(detectContradiction("I've drafted a follow-up message for you — it hasn't been sent.").tripped).toBe(false);
    expect(detectContradiction('I created lead L00042 for John Doe.').tripped).toBe(false);
    expect(detectContradiction('I recorded the payment of $500.').tripped).toBe(false);
    expect(detectContradiction('Would you like me to send this to the customer?').tripped).toBe(false);
    expect(detectContradiction('I can prepare an estimate if you confirm.').tripped).toBe(false);
  });

  it('exposes a generic safe fallback string', () => {
    expect(SAFE_FALLBACK).toMatch(/no changes were made/i);
  });
});

describe('copilot persona', () => {
  it('includes the user, hard rules, and capability list', () => {
    const s = buildSystemInstruction({ userName: 'Jane Tech', role: 'DISPATCHER', orgName: 'Acme HVAC' });
    expect(s).toContain('Servy');
    expect(s).toContain('Jane Tech');
    expect(s).toContain('Acme HVAC');
    expect(s).toMatch(/never\s+send/i);
    expect(s).toMatch(/approval card/i);
    expect(s).toContain('Create a lead');
  });

  it('re-injects recent transcript turns for cross-reconnect memory', () => {
    const s = buildSystemInstruction({
      userName: 'Bob',
      recentTurns: [
        { role: 'user', text: 'how many jobs today' },
        { role: 'assistant', text: 'You have 4 jobs scheduled today.' },
      ],
    });
    expect(s).toContain('RECENT CONVERSATION');
    expect(s).toContain('how many jobs today');
    expect(s).toContain('You have 4 jobs scheduled today.');
  });

  it('is pure (same input → same output)', () => {
    const ctx = { userName: 'X', role: 'ADMIN' };
    expect(buildSystemInstruction(ctx)).toBe(buildSystemInstruction(ctx));
  });

  it('includes reply-style rules: plain text, no markdown, no raw ids', () => {
    const s = buildSystemInstruction({});
    expect(s).toContain('HOW YOU SOUND');
    expect(s).toMatch(/no markdown/i);
    expect(s).toContain('Never show raw record ids');
    expect(s).toContain('never repeat an id back to the user');
  });

  it('includes domain rules: required-field collection, duplicates, lifecycle, scheduling', () => {
    const s = buildSystemInstruction({});
    expect(s).toContain('DOMAIN RULES');
    expect(s).toMatch(/Collect every REQUIRED field conversationally/);
    expect(s).toMatch(/create_lead with customer_name IMMEDIATELY/);
    expect(s).toMatch(/at most ONE question per reply/);
    expect(s).toMatch(/never on your own/i); // duplicates need explicit user opt-in
    expect(s).toMatch(/WON is frozen/);
    expect(s).toMatch(/REPLACES the old one/); // assign crew semantics
    expect(s).toMatch(/non-billable/i); // plan visits
  });
});

describe('copilot capability registry', () => {
  it('has unique ids and required fields', () => {
    const caps = listCapabilities();
    const ids = caps.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of caps) {
      expect(c.id).toBeTruthy();
      expect(c.label).toBeTruthy();
      expect(['read', 'write', 'draft']).toContain(c.mode);
    }
  });

  it('reads/drafts need no approval; writes do', () => {
    for (const c of listCapabilities()) {
      if (c.mode === 'write') expect(c.requiresApproval).toBe(true);
      else expect(c.requiresApproval).toBe(false);
    }
  });

  it('resolves a capability by id', () => {
    expect(getCapability('create_lead')?.endpoint).toBe('POST /api/leads');
    expect(getCapability('nope')).toBeUndefined();
  });
});
