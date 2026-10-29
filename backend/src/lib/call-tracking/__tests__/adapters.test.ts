import { describe, it, expect } from 'vitest';
import { parseTrackedCallEvent, isCallTrackingProvider } from '../adapters';
import { attributionOfEvent } from '../types';

/**
 * CallRail's documented webhook example (Webhooks integration reference), trimmed
 * to the fields the adapter reads. `source_name` is the TRACKER's display name
 * and must never become the marketing source.
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
