// Mobile slice 21 - which ring-first fields a bridge call sends, chosen by the
// server switch CTM_BRIDGE_RING_CALLER; buildBridgeLegs is the ONE place that
// maps the switch to request fields. call_number_caller is the shape PROVEN on
// a live staging call (2026-10-03): call_number = the caller's own phone,
// to_number = the customer. to_number_user_id / to_agent mirror the test-call
// kit's untested candidates (a-user, b).
import { describe, it, expect } from 'vitest';
import { buildBridgeLegs, maskLongDigitRuns } from '../lib/communication/bridgeLegs';

const USER_ID = '00000000-0000-0000-0000-0000000000a1';
const CALLER = { id: USER_ID, phone: '+16095550142', phone_ext: null };
const AGENTS = new Map([[USER_ID, 'agent-77']]);
const CUSTOMER = '+15551234567';

describe('buildBridgeLegs', () => {
  it('off: adds nothing and never looks at the profile phone (a user with no phone still gets legs)', () => {
    expect(buildBridgeLegs('off', { id: USER_ID, phone: null, phone_ext: '12' }, new Map(), CUSTOMER))
      .toEqual({ ok: true, legs: {} });
  });

  it('call_number_caller: the caller profile phone (E.164) is call_number and the customer is to_number, nothing else', () => {
    expect(buildBridgeLegs('call_number_caller', { ...CALLER, phone: '(609) 555-0142' }, AGENTS, CUSTOMER))
      .toStrictEqual({ ok: true, legs: { call_number: '+16095550142', to_number: '+15551234567' } });
  });

  it('to_number_user_id: to_number plus the caller agent id as user_id', () => {
    expect(buildBridgeLegs('to_number_user_id', CALLER, AGENTS, CUSTOMER))
      .toEqual({ ok: true, legs: { to_number: '+16095550142', user_id: 'agent-77' } });
  });

  it('to_agent: sends only to_agent = the caller agent id', () => {
    expect(buildBridgeLegs('to_agent', CALLER, AGENTS, CUSTOMER))
      .toEqual({ ok: true, legs: { to_agent: 'agent-77' } });
  });

  it.each([
    ['null', null],
    ['blank', '   '],
  ])('refuses a %s profile phone with reason missing', (_label, phone) => {
    expect(buildBridgeLegs('call_number_caller', { ...CALLER, phone }, AGENTS, CUSTOMER))
      .toEqual({ ok: false, reason: 'missing' });
  });

  it.each([
    ['too short', '555-0142'],
    ['letters', 'call me'],
    ['11 digits not starting with 1', '2609555014'.slice(0, 9) + '-99'],
  ])('refuses a profile phone that is on file but %s with reason invalid', (_label, phone) => {
    expect(buildBridgeLegs('call_number_caller', { ...CALLER, phone }, AGENTS, CUSTOMER))
      .toEqual({ ok: false, reason: 'invalid' });
  });

  it.each([
    ['10 digits + x204', '609-555-0142 x204'],
    ['1 + 10 digits + ext', '+1 (609) 555-0142 ext. 7'],
  ])('an extension typed inline (%s) is reason extension, not invalid', (_label, phone) => {
    expect(buildBridgeLegs('call_number_caller', { ...CALLER, phone }, AGENTS, CUSTOMER))
      .toEqual({ ok: false, reason: 'extension' });
  });

  it('refuses a profile phone that carries an extension (it cannot ring first)', () => {
    expect(buildBridgeLegs('call_number_caller', { ...CALLER, phone_ext: '204' }, AGENTS, CUSTOMER))
      .toEqual({ ok: false, reason: 'extension' });
  });

  it('a blank extension is not an extension', () => {
    expect(buildBridgeLegs('call_number_caller', { ...CALLER, phone_ext: '  ' }, AGENTS, CUSTOMER))
      .toEqual({ ok: true, legs: { call_number: '+16095550142', to_number: '+15551234567' } });
  });

  it.each(['to_number_user_id', 'to_agent'] as const)(
    '%s: a caller missing from the agent map is refused with reason agent_missing',
    (mode) => {
      expect(buildBridgeLegs(mode, CALLER, new Map([['someone-else', 'agent-1']]), CUSTOMER))
        .toEqual({ ok: false, reason: 'agent_missing' });
    },
  );

  it('looks the caller up in the agent map case-insensitively (map keys are lowercased at parse)', () => {
    const upper = { ...CALLER, id: '00000000-0000-0000-0000-0000000000A1' };
    expect(buildBridgeLegs('to_agent', upper, AGENTS, CUSTOMER))
      .toEqual({ ok: true, legs: { to_agent: 'agent-77' } });
  });

  it('refuses when the caller profile phone IS the customer number', () => {
    expect(buildBridgeLegs('call_number_caller', CALLER, AGENTS, '+16095550142'))
      .toEqual({ ok: false, reason: 'caller_is_customer' });
  });

  it('a different customer number is fine', () => {
    expect(buildBridgeLegs('call_number_caller', CALLER, AGENTS, '+15551234567'))
      .toEqual({ ok: true, legs: { call_number: '+16095550142', to_number: '+15551234567' } });
  });

  it('off never compares against the customer number', () => {
    expect(buildBridgeLegs('off', CALLER, AGENTS, '+16095550142'))
      .toEqual({ ok: true, legs: {} });
  });

  it('to_agent still requires a usable profile phone (the rule is the same in every mode)', () => {
    expect(buildBridgeLegs('to_agent', { ...CALLER, phone: null }, AGENTS, CUSTOMER))
      .toEqual({ ok: false, reason: 'missing' });
  });
});

describe('maskLongDigitRuns', () => {
  it.each([
    ['bare E.164', 'invalid to_number +16095550142', 'invalid to_number ***0142'],
    ['formatted', 'cannot dial (609) 555-0142 now', 'cannot dial ***0142 now'],
    ['dashed', 'bad 609-555-0142', 'bad ***0142'],
  ])('masks a %s phone-like run to its last 4 digits', (_label, raw, masked) => {
    expect(maskLongDigitRuns(raw)).toBe(masked);
  });

  it('leaves short numbers alone (status codes, small ids)', () => {
    expect(maskLongDigitRuns('error 406: limit 30 per 60s')).toBe('error 406: limit 30 per 60s');
  });
});
