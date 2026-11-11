import { describe, it, expect } from 'vitest';
import { parseTrackedCallEvent, isCallTrackingProvider } from '../adapters';
import { attributionOfEvent } from '../types';
import { CALLRAIL_WEBHOOK_PRE, CALLRAIL_WEBHOOK_POST } from './fixtures/callrail-webhook';

/**
 * The vendor's API description of a call record. NOT what its Webhooks
 * integration sends (that is ./fixtures/callrail-webhook.ts); kept because the
 * adapter still accepts these names as a fallback. `source_name` is the
 * TRACKER's display name and must never become the marketing source.
 */
const CALLRAIL_PRE = {
  id: 'CAL8154bbf4a4e14d2c9a0f5d5e8c3f2b1a',
  answered: null,
  business_phone_number: null,
  customer_city: 'Trenton',
  customer_country: 'US',
  customer_name: 'JANE DOE',
  customer_phone_number: '+16095550123',
  customer_state: 'NJ',
  direction: 'inbound',
  duration: null,
  recording: null,
  start_time: '2026-09-10T10:15:30.000-04:00',
  tracking_phone_number: '+18565708007',
  source: 'Google Ads',
  source_name: 'Website Pool',
  medium: 'cpc',
  campaign: 'Kitchen Cabinets - Search',
  keywords: 'custom cabinets nj',
  landing_page_url: 'https://example.com/kitchen?gclid=Cj0abc',
  referring_url: 'https://www.google.com/',
  gclid: 'Cj0abc',
  fbclid: null,
  msclkid: '',
  first_call: true,
};

const CALLRAIL_POST = {
  ...CALLRAIL_PRE,
  answered: true,
  duration: '184',
  recording: 'https://app.callrail.com/calls/CAL8154bbf4a4e14d2c9a0f5d5e8c3f2b1a/recording/redirect?access_key=abc',
};

const WHATCONVERTS = {
  lead_id: 4471023,
  lead_type: 'Phone Call',
  date_created: '2026-09-10T14:15:30Z',
  caller_number: '(609) 555-0123',
  tracking_number: '+18565708007',
  lead_source: 'google',
  lead_medium: 'cpc',
  lead_campaign: 'Brand',
  lead_keyword: 'cabinet company',
  landing_url: 'https://example.com/',
  gclid: 'Cj0xyz',
  call_duration: 61,
};

describe('call-tracking adapters', () => {
  it('knows exactly the two providers', () => {
    expect(isCallTrackingProvider('callrail')).toBe(true);
    expect(isCallTrackingProvider('whatconverts')).toBe(true);
    expect(isCallTrackingProvider('ctm')).toBe(false);
    expect(isCallTrackingProvider('')).toBe(false);
  });

  describe('CallRail', () => {
    it('parses a pre_call: phase pre, marketing source (never source_name), E.164 numbers, offset time kept', () => {
      const e = parseTrackedCallEvent('callrail', CALLRAIL_PRE);
      expect(e).not.toBeNull();
      expect(e!.provider).toBe('callrail');
      expect(e!.phase).toBe('pre');
      expect(e!.vendorCallId).toBe('CAL8154bbf4a4e14d2c9a0f5d5e8c3f2b1a');
      expect(e!.callerNumber).toBe('+16095550123');
      expect(e!.trackingNumber).toBe('+18565708007');
      expect(e!.startedAt.toISOString()).toBe('2026-09-10T14:15:30.000Z');
      expect(e!.source).toBe('Google Ads');
      expect(e!.medium).toBe('cpc');
      expect(e!.campaign).toBe('Kitchen Cabinets - Search');
      expect(e!.keywords).toBe('custom cabinets nj');
      expect(e!.landingPageUrl).toBe('https://example.com/kitchen?gclid=Cj0abc');
      expect(e!.referringUrl).toBe('https://www.google.com/');
      expect(e!.gclid).toBe('Cj0abc');
      expect(e!.fbclid).toBeNull();
      expect(e!.msclkid).toBeNull();
      expect(e!.firstCall).toBe(true);
      expect(e!.durationSec).toBeNull();
      expect(e!.recordingUrl).toBeNull();
    });

    it('parses a post_call: phase post from the presence of duration/recording, duration coerced to a number', () => {
      const e = parseTrackedCallEvent('callrail', CALLRAIL_POST);
      expect(e!.phase).toBe('post');
      expect(e!.durationSec).toBe(184);
      expect(e!.recordingUrl).toMatch(/^https:\/\/app\.callrail\.com\//);
    });

    it('honours the route phase hint over content detection', () => {
      expect(parseTrackedCallEvent('callrail', CALLRAIL_PRE, 'post')!.phase).toBe('post');
      expect(parseTrackedCallEvent('callrail', CALLRAIL_POST, 'pre')!.phase).toBe('pre');
    });

    it('rejects a body without id or customer number', () => {
      expect(parseTrackedCallEvent('callrail', { source: 'x' })).toBeNull();
      expect(parseTrackedCallEvent('callrail', { id: 'CAL1' })).toBeNull();
      expect(parseTrackedCallEvent('callrail', { customer_phone_number: '+16095550123' })).toBeNull();
      expect(parseTrackedCallEvent('callrail', [])).toBeNull();
      expect(parseTrackedCallEvent('callrail', 'string')).toBeNull();
      expect(parseTrackedCallEvent('callrail', null)).toBeNull();
    });

    it('keeps a non-North-American caller as sent rather than dropping the event', () => {
      const e = parseTrackedCallEvent('callrail', { ...CALLRAIL_PRE, customer_phone_number: '+442071234567' });
      expect(e!.callerNumber).toBe('+442071234567');
    });

    it('falls back to now when start_time is unparseable', () => {
      const before = Date.now();
      const e = parseTrackedCallEvent('callrail', { ...CALLRAIL_PRE, start_time: 'not a date' });
      expect(e!.startedAt.getTime()).toBeGreaterThanOrEqual(before);
    });
  });

  describe('CallRail Webhooks integration: the shape production actually receives (#3447)', () => {
    it('recognises a real-shaped pre-call and maps every marketing field', () => {
      const e = parseTrackedCallEvent('callrail', CALLRAIL_WEBHOOK_PRE, 'pre');
      expect(e).not.toBeNull();
      expect(e!.phase).toBe('pre');
      expect(e!.vendorCallId).toBe('CAL0000test0000pre0000000000000001');
      expect(e!.callerNumber).toBe('+16095550123');
      expect(e!.trackingNumber).toBe('+18565550100');
      expect(e!.source).toBe('Google Ad Extension');
      expect(e!.medium).toBe('cpc');
      expect(e!.campaign).toBe('Ads Extension');
      expect(e!.keywords).toBe('custom kitchen cabinets');
      expect(e!.landingPageUrl).toBe('https://www.example.com/showroom/?keyword=custom+kitchen+cabinets');
      expect(e!.referringUrl).toBe('https://www.google.com/');
      expect(e!.gclid).toBe('Cj0TESTgclid');
      expect(e!.firstCall).toBe(true);
    });

    it('reads `datetime` as UTC whatever the server zone is', () => {
      const e = parseTrackedCallEvent('callrail', CALLRAIL_WEBHOOK_PRE, 'pre');
      expect(e!.startedAt.toISOString()).toBe('2026-11-11T14:20:45.000Z');
    });

    it('a pre-call carries no duration and no recording, even though the wire sends "0" and ""', () => {
      const e = parseTrackedCallEvent('callrail', CALLRAIL_WEBHOOK_PRE, 'pre');
      expect(e!.durationSec).toBeNull();
      expect(e!.recordingUrl).toBeNull();
      expect(attributionOfEvent(e!)).not.toHaveProperty('vendor_duration_sec');
    });

    it('without a route hint, "0" duration and an empty recording still mean pre', () => {
      expect(parseTrackedCallEvent('callrail', CALLRAIL_WEBHOOK_PRE)!.phase).toBe('pre');
      expect(parseTrackedCallEvent('callrail', CALLRAIL_WEBHOOK_POST)!.phase).toBe('post');
    });

    it('a post-call carries the duration and the recording link', () => {
      const e = parseTrackedCallEvent('callrail', CALLRAIL_WEBHOOK_POST, 'post');
      expect(e!.vendorCallId).toBe('CAL0000test0000pre0000000000000001');
      expect(e!.durationSec).toBe(230);
      expect(e!.recordingUrl).toBe(CALLRAIL_WEBHOOK_POST.recording);
    });

    it('falls back to `callernum` when `customer_phone_number` is absent', () => {
      const { customer_phone_number: _drop, ...body } = CALLRAIL_WEBHOOK_PRE;
      expect(parseTrackedCallEvent('callrail', body, 'pre')!.callerNumber).toBe('+16095550123');
    });

    it('falls back to `utm_term` for the keyword and `referrermedium` for the medium', () => {
      const e = parseTrackedCallEvent(
        'callrail',
        { ...CALLRAIL_WEBHOOK_PRE, keywords: '', utm_term: 'cabinet showroom', utm_medium: '' },
        'pre',
      );
      expect(e!.keywords).toBe('cabinet showroom');
      expect(e!.medium).toBe('cpc');
    });

    it('keeps an already-readable source as sent and only re-cases a snake_case one', () => {
      expect(parseTrackedCallEvent('callrail', { ...CALLRAIL_WEBHOOK_PRE, callsource: 'direct' }, 'pre')!.source).toBe('Direct');
      expect(
        parseTrackedCallEvent('callrail', { ...CALLRAIL_WEBHOOK_PRE, callsource: 'Website Pool A' }, 'pre')!.source,
      ).toBe('Website Pool A');
      expect(parseTrackedCallEvent('callrail', { ...CALLRAIL_WEBHOOK_PRE, callsource: '' }, 'pre')!.source).toBeNull();
    });

    it('never carries the caller\'s name or location into the attribution block', () => {
      const attr = attributionOfEvent(parseTrackedCallEvent('callrail', CALLRAIL_WEBHOOK_POST, 'post')!);
      const flat = JSON.stringify(attr);
      expect(flat).not.toContain('DOE');
      expect(flat).not.toContain('Trenton');
      expect(attr).toMatchObject({
        source: 'Google Ad Extension',
        medium: 'cpc',
        campaign: 'Ads Extension',
        keyword: 'custom kitchen cabinets',
        gclid: 'Cj0TESTgclid',
        tracking_number: '+18565550100',
        vendor_duration_sec: 230,
      });
    });

    it('still refuses a body with no call id or no caller', () => {
      const { resource_id: _id, ...noId } = CALLRAIL_WEBHOOK_PRE;
      expect(parseTrackedCallEvent('callrail', noId, 'pre')).toBeNull();
      const { customer_phone_number: _a, callernum: _b, ...noCaller } = CALLRAIL_WEBHOOK_PRE;
      expect(parseTrackedCallEvent('callrail', noCaller, 'pre')).toBeNull();
    });
  });

  describe('WhatConverts', () => {
    it('parses a lead: phase pre, UTC time, formatted caller normalised, lead_* fields mapped', () => {
      const e = parseTrackedCallEvent('whatconverts', WHATCONVERTS);
      expect(e).not.toBeNull();
      expect(e!.provider).toBe('whatconverts');
      expect(e!.phase).toBe('pre');
      expect(e!.vendorCallId).toBe('4471023');
      expect(e!.callerNumber).toBe('+16095550123');
      expect(e!.trackingNumber).toBe('+18565708007');
      expect(e!.startedAt.toISOString()).toBe('2026-09-10T14:15:30.000Z');
      expect(e!.source).toBe('google');
      expect(e!.medium).toBe('cpc');
      expect(e!.campaign).toBe('Brand');
      expect(e!.keywords).toBe('cabinet company');
      expect(e!.landingPageUrl).toBe('https://example.com/');
      expect(e!.gclid).toBe('Cj0xyz');
      expect(e!.durationSec).toBe(61);
      expect(e!.firstCall).toBeNull();
    });

    it('rejects a body without lead_id or caller_number', () => {
      expect(parseTrackedCallEvent('whatconverts', { lead_source: 'google' })).toBeNull();
      expect(parseTrackedCallEvent('whatconverts', { lead_id: 1 })).toBeNull();
    });
  });

  describe('attributionOfEvent', () => {
    it('uses the phone system\'s own key names (source/medium/campaign/keyword/referrer) and drops empties', () => {
      const e = parseTrackedCallEvent('callrail', CALLRAIL_POST)!;
      const attr = attributionOfEvent(e);
      expect(attr).toEqual({
        source: 'Google Ads',
        medium: 'cpc',
        campaign: 'Kitchen Cabinets - Search',
        keyword: 'custom cabinets nj',
        referrer: 'https://www.google.com/',
        landing_page: 'https://example.com/kitchen?gclid=Cj0abc',
        gclid: 'Cj0abc',
        first_call: true,
        tracking_number: '+18565708007',
        vendor_duration_sec: 184,
        vendor_recording_url: CALLRAIL_POST.recording,
      });
      expect(attr).not.toHaveProperty('fbclid');
      expect(attr).not.toHaveProperty('msclkid');
    });
  });
});
