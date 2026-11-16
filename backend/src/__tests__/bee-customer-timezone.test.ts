import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '../lib/prisma';
import { BeeService } from '../services/bee/beeService';
import { BeeVoiceAdapter } from '../services/bee/beeVoiceAdapter';
import {
  resolveCustomerTimezone,
  isWithinAllowedCallingWindow,
  formatScheduledTimeInCustomerTimezone,
  setCustomAddressGeocoder,
  clearTimezoneCache,
  lookupTimezoneByZip,
  lookupTimezoneByCityState,
  lookupTimezoneByState,
} from '../services/bee/timezoneService';

describe('Bee Customer Timezone-Aware Calling and Resolution', () => {
  const orgId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    clearTimezoneCache();
    setCustomAddressGeocoder(null);
  });

  afterEach(() => {
    clearTimezoneCache();
    setCustomAddressGeocoder(null);
  });

  describe('1. Priority 1: Full Address Geocoding', () => {
    it('resolves exact IANA timezone via full address geocoding when coordinates/address match', async () => {
      // Mock geocoder returning America/Los_Angeles for a full street address in Seattle
      setCustomAddressGeocoder(async (fullAddr) => {
        if (fullAddr.includes('123 Pike St')) {
          return 'America/Los_Angeles';
        }
        return null;
      });

      const res = await resolveCustomerTimezone({
        address: '123 Pike St',
        city: 'Seattle',
        state: 'WA',
        zip: '98101',
      });

      expect(res.timezone).toBe('America/Los_Angeles');
      expect(res.source).toBe('customer_address');
      expect(res.is_estimated).toBe(false);
    });
  });

  describe('2. Priority 2: 5-Digit US Postal Code Lookup', () => {
    it('falls back to 5-digit US ZIP code lookup when address geocoding fails or is unavailable', async () => {
      // Geocoder fails/times out
      setCustomAddressGeocoder(async () => null);

      const res = await resolveCustomerTimezone({
        address: '999 Unknown Dirt Rd',
        city: 'Newark',
        state: 'NJ',
        zip: '07102',
      });

      expect(res.timezone).toBe('America/New_York');
      expect(res.source).toBe('zip_code');
      expect(res.is_estimated).toBe(false);
    });

    it('resolves correct timezones for standard US ZIP ranges and split-state ZIP exceptions', () => {
      // Los Angeles, CA
      expect(lookupTimezoneByZip('90210')).toBe('America/Los_Angeles');
      // Chicago, IL
      expect(lookupTimezoneByZip('60601')).toBe('America/Chicago');
      // Denver, CO
      expect(lookupTimezoneByZip('80202')).toBe('America/Denver');
      // Miami, FL (Eastern)
      expect(lookupTimezoneByZip('33101')).toBe('America/New_York');
      // Pensacola, FL (Central panhandle: 325xx)
      expect(lookupTimezoneByZip('32501')).toBe('America/Chicago');
      // Dallas, TX (Central: 75201)
      expect(lookupTimezoneByZip('75201')).toBe('America/Chicago');
      // El Paso, TX (Mountain: 79901)
      expect(lookupTimezoneByZip('79901')).toBe('America/Denver');
      // Boise, ID (Mountain: 83702)
      expect(lookupTimezoneByZip('83702')).toBe('America/Boise');
      // Coeur d'Alene, ID (Pacific: 83814)
      expect(lookupTimezoneByZip('83814')).toBe('America/Los_Angeles');
      // Honolulu, HI
      expect(lookupTimezoneByZip('96815')).toBe('Pacific/Honolulu');
      // Anchorage, AK
      expect(lookupTimezoneByZip('99501')).toBe('America/Anchorage');
    });
  });

  describe('3. Priority 3: City and State Lookup', () => {
    it('falls back to city and state lookup when ZIP code is missing or unmatchable', async () => {
      setCustomAddressGeocoder(async () => null);

      // Dallas, TX in split state resolves to Central
      const resDallas = await resolveCustomerTimezone({
        city: 'Dallas',
        state: 'TX',
        zip: null,
      });
      expect(resDallas.timezone).toBe('America/Chicago');
      expect(resDallas.source).toBe('city_state');
      expect(resDallas.is_estimated).toBe(false);

      // El Paso, TX in split state resolves to Mountain
      const resElPaso = await resolveCustomerTimezone({
        city: 'El Paso',
        state: 'TX',
        zip: '',
      });
      expect(resElPaso.timezone).toBe('America/Denver');
      expect(resElPaso.source).toBe('city_state');
      expect(resElPaso.is_estimated).toBe(false);

      // Pensacola, FL in split state resolves to Central
      const resPensacola = await resolveCustomerTimezone({
        city: 'Pensacola',
        state: 'FL',
        zip: null,
      });
      expect(resPensacola.timezone).toBe('America/Chicago');
      expect(resPensacola.source).toBe('city_state');
      expect(resPensacola.is_estimated).toBe(false);
    });

    it('resolves any city in a single-timezone state as city_state without estimation', async () => {
      setCustomAddressGeocoder(async () => null);

      const res = await resolveCustomerTimezone({
        city: 'Sacramento',
        state: 'CA',
        zip: null,
      });
      expect(res.timezone).toBe('America/Los_Angeles');
      expect(res.source).toBe('city_state');
      expect(res.is_estimated).toBe(false);
    });
  });

  describe('4. Priority 4: State-Level Fallback (Single vs Split States)', () => {
    it('falls back to state-level for single-timezone states without estimated flag', async () => {
      setCustomAddressGeocoder(async () => null);

      // New Jersey is 100% Eastern
      const resNJ = await resolveCustomerTimezone({
        state: 'NJ',
      });
      expect(resNJ.timezone).toBe('America/New_York');
      expect(resNJ.source).toBe('state');
      expect(resNJ.is_estimated).toBe(false);

      // California is 100% Pacific
      const resCA = await resolveCustomerTimezone({
        state: 'California',
      });
      expect(resCA.timezone).toBe('America/Los_Angeles');
      expect(resCA.source).toBe('state');
      expect(resCA.is_estimated).toBe(false);

      // Colorado is 100% Mountain
      const resCO = await resolveCustomerTimezone({
        state: 'CO',
      });
      expect(resCO.timezone).toBe('America/Denver');
      expect(resCO.source).toBe('state');
      expect(resCO.is_estimated).toBe(false);
    });

    it('falls back to state dominant timezone for split states and flags as estimated: true', async () => {
      setCustomAddressGeocoder(async () => null);

      // Florida (split: Eastern dominant, Panhandle Central)
      const resFL = await resolveCustomerTimezone({
        state: 'FL',
      });
      expect(resFL.timezone).toBe('America/New_York');
      expect(resFL.source).toBe('state_estimate');
      expect(resFL.is_estimated).toBe(true);

      // Texas (split: Central dominant, El Paso Mountain)
      const resTX = await resolveCustomerTimezone({
        state: 'Texas',
      });
      expect(resTX.timezone).toBe('America/Chicago');
      expect(resTX.source).toBe('state_estimate');
      expect(resTX.is_estimated).toBe(true);

      // Tennessee (split: Central dominant, East TN Eastern)
      const resTN = await resolveCustomerTimezone({
        state: 'TN',
      });
      expect(resTN.timezone).toBe('America/Chicago');
      expect(resTN.source).toBe('state_estimate');
      expect(resTN.is_estimated).toBe(true);

      // Idaho (split: Mountain dominant, Panhandle Pacific)
      const resID = await resolveCustomerTimezone({
        state: 'ID',
      });
      expect(resID.timezone).toBe('America/Boise');
      expect(resID.source).toBe('state_estimate');
      expect(resID.is_estimated).toBe(true);
    });
  });

  describe('5. Priority 5: System Default Timezone Fallback', () => {
    it('falls back to configured system default timezone when no geographic data is available', async () => {
      setCustomAddressGeocoder(async () => null);

      const res = await resolveCustomerTimezone({}, 'America/Chicago');
      expect(res.timezone).toBe('America/Chicago');
      expect(res.source).toBe('system_default');
      expect(res.is_estimated).toBe(false);

      const resNull = await resolveCustomerTimezone(
        { address: null, city: null, state: null, zip: null },
        'America/Denver'
      );
      expect(resNull.timezone).toBe('America/Denver');
      expect(resNull.source).toBe('system_default');
      expect(resNull.is_estimated).toBe(false);
    });
  });

  describe('6. Calling Days Enforcement in Customer Local Timezone', () => {
    it('evaluates calling days using customer local day of week, not UTC or server day', () => {
      // UTC Saturday 2026-10-24 01:30:00 is Friday 2026-10-23 18:30:00 in America/Los_Angeles (Pacific Daylight Time)
      const pacificFridayLocal = new Date('2026-10-24T01:30:00.000Z');

      const allowedDaysMonFri = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

      // In customer's timezone (America/Los_Angeles), it is Friday 6:30 PM -> within Mon-Fri!
      const isAllowedInPacific = isWithinAllowedCallingWindow(pacificFridayLocal, {
        windowStart: '10:00',
        windowEnd: '19:00',
        callDays: allowedDaysMonFri,
        timezone: 'America/Los_Angeles',
      });
      expect(isAllowedInPacific).toBe(true);

      // In America/New_York (Eastern), it is already Saturday 2026-10-24 21:30 -> Saturday is not allowed!
      const isAllowedInEastern = isWithinAllowedCallingWindow(pacificFridayLocal, {
        windowStart: '10:00',
        windowEnd: '19:00',
        callDays: allowedDaysMonFri,
        timezone: 'America/New_York',
      });
      expect(isAllowedInEastern).toBe(false);
    });

    it('rejects calls on unconfigured days in customer local time', () => {
      // Sunday in America/Chicago: 2026-10-25 14:00 Central (19:00 UTC)
      const sundayCentral = new Date('2026-10-25T19:00:00.000Z');

      const res = isWithinAllowedCallingWindow(sundayCentral, {
        windowStart: '10:00',
        windowEnd: '19:00',
        callDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        timezone: 'America/Chicago',
      });
      expect(res).toBe(false);
    });
  });

  describe('7. Calling Hours Enforcement in Customer Local Timezone', () => {
    it('evaluates calling window using customer local hour of day', () => {
      // 16:30 UTC:
      // In New York (EDT, UTC-4), it is 12:30 PM (Noon) -> inside 10:00-19:00
      // In Los Angeles (PDT, UTC-7), it is 09:30 AM -> BEFORE 10:00 AM!
      const date1630Utc = new Date('2026-06-15T16:30:00.000Z');

      const allowedInNY = isWithinAllowedCallingWindow(date1630Utc, {
        windowStart: '10:00',
        windowEnd: '19:00',
        callDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        timezone: 'America/New_York',
      });
      expect(allowedInNY).toBe(true);

      const allowedInLA = isWithinAllowedCallingWindow(date1630Utc, {
        windowStart: '10:00',
        windowEnd: '19:00',
        callDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        timezone: 'America/Los_Angeles',
      });
      expect(allowedInLA).toBe(false);
    });

    it('prevents calling after end hour in customer local time', () => {
      // 00:30 UTC on Tuesday (2026-06-16T00:30:00Z):
      // In New York, it is 20:30 (8:30 PM) -> after 19:00 window end!
      // In Los Angeles, it is 17:30 (5:30 PM) -> inside 10:00-19:00 window!
      const date0030Utc = new Date('2026-06-16T00:30:00.000Z');

      const allowedInNY = isWithinAllowedCallingWindow(date0030Utc, {
        windowStart: '10:00',
        windowEnd: '19:00',
        callDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        timezone: 'America/New_York',
      });
      expect(allowedInNY).toBe(false);

      const allowedInLA = isWithinAllowedCallingWindow(date0030Utc, {
        windowStart: '10:00',
        windowEnd: '19:00',
        callDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        timezone: 'America/Los_Angeles',
      });
      expect(allowedInLA).toBe(true);
    });
  });

  describe('8. Daylight Saving Time Transitions and Formatting', () => {
    it('accurately resolves DST abbreviation and hour offsets across seasons', () => {
      // Summer (EDT - Daylight Saving Time)
      const summerDate = new Date('2026-07-15T18:00:00.000Z');
      const summerFormatted = formatScheduledTimeInCustomerTimezone(
        summerDate,
        'America/New_York',
        'customer_address',
        false
      );
      expect(summerFormatted.localTime).toBe('14:00');
      expect(summerFormatted.tzAbbr).toBe('EDT');
      expect(summerFormatted.badgeLabel).toBe('Customer Timezone');

      // Winter (EST - Standard Time)
      const winterDate = new Date('2026-01-15T19:00:00.000Z');
      const winterFormatted = formatScheduledTimeInCustomerTimezone(
        winterDate,
        'America/New_York',
        'customer_address',
        false
      );
      expect(winterFormatted.localTime).toBe('14:00');
      expect(winterFormatted.tzAbbr).toBe('EST');
    });

    it('displays appropriate badges for customer, estimated, and default timezones', () => {
      const now = new Date('2026-09-20T18:00:00.000Z');

      // Direct customer address
      const resAddr = formatScheduledTimeInCustomerTimezone(
        now,
        'America/Los_Angeles',
        'customer_address',
        false
      );
      expect(resAddr.badgeLabel).toBe('Customer Timezone');
      expect(resAddr.badgeVariant).toBe('customer');

      // Split-state estimate
      const resEst = formatScheduledTimeInCustomerTimezone(
        now,
        'America/Chicago',
        'state_estimate',
        true
      );
      expect(resEst.badgeLabel).toBe('Customer Timezone · Estimated');
      expect(resEst.badgeVariant).toBe('customer');

      // System default fallback
      const resDef = formatScheduledTimeInCustomerTimezone(
        now,
        'America/New_York',
        'system_default',
        false
      );
      expect(resDef.badgeLabel).toBe('Default Timezone');
      expect(resDef.badgeVariant).toBe('default');
    });
  });

  describe('9. Queue Processing Deferral Honors Local Timezone', () => {
    it('defers due queue item when customer local time is outside calling window', async () => {
      // Due at 2026-06-15 16:30 UTC
      // At this UTC time:
      // California is 09:30 AM (outside 10:00-19:00 window)
      const dueTime = new Date('2026-06-15T16:30:00.000Z');

      const mockQueueItem = {
        id: '11111111-2222-3333-4444-555555555555',
        organization_id: orgId,
        customer_id: 'cust-1',
        customer_name: 'California Client',
        customer_phone: '+15559876543',
        status: 'scheduled',
        attempt_count: 0,
        scheduled_for: dueTime,
        customer_timezone: 'America/Los_Angeles',
        timezone_source: 'zip_code',
        is_timezone_estimated: false,
        warranty_record: {
          id: 'rec-1',
          organization_id: orgId,
          job_id: 'job-1',
          customer_id: 'cust-1',
          job_type: 'HVAC',
          status: 'active',
        },
      };

      vi.mocked(prisma.beeQueueItem.findMany).mockResolvedValueOnce([mockQueueItem as any]);
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
        id: 'setting-1',
        organization_id: orgId,
        is_active: true,
        call_window_start: '10:00',
        call_window_end: '19:00',
        timezone: 'America/New_York', // Org is Eastern (12:30 PM), but customer is Pacific (09:30 AM)!
        setup_config: { callDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
        max_retries: 2,
        retry_interval_hours: 48,
      } as any);

      // Mock enrichQueueItemsWithJobContext
      vi.spyOn(BeeService, 'enrichQueueItemsWithJobContext').mockResolvedValueOnce([
        {
          ...mockQueueItem,
          customer_timezone: 'America/Los_Angeles',
          timezone_source: 'zip_code',
          is_timezone_estimated: false,
        } as any,
      ]);

      const voiceSpy = vi.spyOn(BeeVoiceAdapter, 'initiateCall');

      // Run processDueQueueItems: Mock now as dueTime
      vi.useFakeTimers();
      vi.setSystemTime(dueTime);

      const result = await BeeService.processDueQueueItems();

      // Since California customer is at 09:30 AM, call MUST be deferred!
      expect(voiceSpy).not.toHaveBeenCalled();
      expect(result.processed).toBe(0);

      vi.useRealTimers();
    });

    it('triggers due call when customer local time is within window and allowed days', async () => {
      // 19:30 UTC: In California (America/Los_Angeles) it is 12:30 PM (Monday)
      const dueTime = new Date('2026-06-15T19:30:00.000Z');

      const mockQueueItem = {
        id: '22222222-3333-4444-5555-666666666666',
        organization_id: orgId,
        customer_id: 'cust-2',
        customer_name: 'California Client Ready',
        customer_phone: '+15559876543',
        status: 'scheduled',
        attempt_count: 0,
        scheduled_for: dueTime,
        customer_timezone: 'America/Los_Angeles',
        timezone_source: 'zip_code',
        is_timezone_estimated: false,
        warranty_record: {
          id: 'rec-2',
          organization_id: orgId,
          job_id: 'job-2',
          customer_id: 'cust-2',
          job_type: 'General Service',
          status: 'active',
        },
      };

      vi.mocked(prisma.beeQueueItem.findMany).mockResolvedValueOnce([mockQueueItem as any]);
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
        id: 'setting-1',
        organization_id: orgId,
        is_active: true,
        call_window_start: '10:00',
        call_window_end: '19:00',
        timezone: 'America/New_York',
        setup_config: { callDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
        max_retries: 2,
        retry_interval_hours: 48,
      } as any);

      vi.spyOn(BeeService, 'enrichQueueItemsWithJobContext').mockResolvedValueOnce([
        {
          ...mockQueueItem,
          customer_timezone: 'America/Los_Angeles',
          timezone_source: 'zip_code',
          is_timezone_estimated: false,
        } as any,
      ]);

      vi.spyOn(BeeService as any, 'isDnc').mockResolvedValueOnce(false);
      vi.spyOn(BeeService, 'getJobTypeWarranties').mockResolvedValueOnce([]);
      vi.spyOn(BeeService as any, 'createInitialCallLog').mockResolvedValue(null);

      vi.mocked(prisma.beeQueueItem.update).mockResolvedValue({
        ...mockQueueItem,
        status: 'in_progress',
      } as any);

      const voiceSpy = vi.spyOn(BeeVoiceAdapter, 'initiateCall').mockResolvedValueOnce({
        callId: 'call-1',
        status: 'initiated',
        provider: 'simulated',
      } as any);

      vi.useFakeTimers();
      vi.setSystemTime(dueTime);

      const result = await BeeService.processDueQueueItems();

      expect(voiceSpy).toHaveBeenCalledTimes(1);
      expect(result.processed).toBe(1);

      vi.useRealTimers();
    });
  });
});
