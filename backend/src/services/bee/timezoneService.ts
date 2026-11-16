import { logger } from '../../lib/logger';

export type TimezoneSource =
  | 'customer_address'
  | 'zip_code'
  | 'city_state'
  | 'state'
  | 'state_estimate'
  | 'system_default';

export interface CustomerAddressInput {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export interface ResolvedTimezone {
  timezone: string;
  source: TimezoneSource;
  is_estimated: boolean;
}

export interface CallingWindowOptions {
  windowStart: string; // e.g. "10:00"
  windowEnd: string;   // e.g. "19:00"
  callDays?: string[]; // e.g. ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
  timezone: string;    // customer's resolved IANA timezone
}

// In-memory cache for resolved timezones
const timezoneResolutionCache = new Map<string, ResolvedTimezone>();

export function clearTimezoneCache(): void {
  timezoneResolutionCache.clear();
}

/**
 * 50 US States + DC data:
 * single-timezone vs split-timezone and dominant timezone
 */
interface StateInfo {
  name: string;
  dominantTimezone: string;
  isSplit: boolean;
}

export const US_STATES: Record<string, StateInfo> = {
  AL: { name: 'Alabama', dominantTimezone: 'America/Chicago', isSplit: false },
  AK: { name: 'Alaska', dominantTimezone: 'America/Anchorage', isSplit: true },
  AZ: { name: 'Arizona', dominantTimezone: 'America/Phoenix', isSplit: false },
  AR: { name: 'Arkansas', dominantTimezone: 'America/Chicago', isSplit: false },
  CA: { name: 'California', dominantTimezone: 'America/Los_Angeles', isSplit: false },
  CO: { name: 'Colorado', dominantTimezone: 'America/Denver', isSplit: false },
  CT: { name: 'Connecticut', dominantTimezone: 'America/New_York', isSplit: false },
  DE: { name: 'Delaware', dominantTimezone: 'America/New_York', isSplit: false },
  DC: { name: 'District of Columbia', dominantTimezone: 'America/New_York', isSplit: false },
  FL: { name: 'Florida', dominantTimezone: 'America/New_York', isSplit: true },
  GA: { name: 'Georgia', dominantTimezone: 'America/New_York', isSplit: false },
  HI: { name: 'Hawaii', dominantTimezone: 'Pacific/Honolulu', isSplit: false },
  ID: { name: 'Idaho', dominantTimezone: 'America/Boise', isSplit: true },
  IL: { name: 'Illinois', dominantTimezone: 'America/Chicago', isSplit: false },
  IN: { name: 'Indiana', dominantTimezone: 'America/Indiana/Indianapolis', isSplit: true },
  IA: { name: 'Iowa', dominantTimezone: 'America/Chicago', isSplit: false },
  KS: { name: 'Kansas', dominantTimezone: 'America/Chicago', isSplit: true },
  KY: { name: 'Kentucky', dominantTimezone: 'America/New_York', isSplit: true },
  LA: { name: 'Louisiana', dominantTimezone: 'America/Chicago', isSplit: false },
  ME: { name: 'Maine', dominantTimezone: 'America/New_York', isSplit: false },
  MD: { name: 'Maryland', dominantTimezone: 'America/New_York', isSplit: false },
  MA: { name: 'Massachusetts', dominantTimezone: 'America/New_York', isSplit: false },
  MI: { name: 'Michigan', dominantTimezone: 'America/Detroit', isSplit: true },
  MN: { name: 'Minnesota', dominantTimezone: 'America/Chicago', isSplit: false },
  MS: { name: 'Mississippi', dominantTimezone: 'America/Chicago', isSplit: false },
  MO: { name: 'Missouri', dominantTimezone: 'America/Chicago', isSplit: false },
  MT: { name: 'Montana', dominantTimezone: 'America/Denver', isSplit: false },
  NE: { name: 'Nebraska', dominantTimezone: 'America/Chicago', isSplit: true },
  NV: { name: 'Nevada', dominantTimezone: 'America/Los_Angeles', isSplit: false },
  NH: { name: 'New Hampshire', dominantTimezone: 'America/New_York', isSplit: false },
  NJ: { name: 'New Jersey', dominantTimezone: 'America/New_York', isSplit: false },
  NM: { name: 'New Mexico', dominantTimezone: 'America/Denver', isSplit: false },
  NY: { name: 'New York', dominantTimezone: 'America/New_York', isSplit: false },
  NC: { name: 'North Carolina', dominantTimezone: 'America/New_York', isSplit: false },
  ND: { name: 'North Dakota', dominantTimezone: 'America/Chicago', isSplit: true },
  OH: { name: 'Ohio', dominantTimezone: 'America/New_York', isSplit: false },
  OK: { name: 'Oklahoma', dominantTimezone: 'America/Chicago', isSplit: false },
  OR: { name: 'Oregon', dominantTimezone: 'America/Los_Angeles', isSplit: true },
  PA: { name: 'Pennsylvania', dominantTimezone: 'America/New_York', isSplit: false },
  RI: { name: 'Rhode Island', dominantTimezone: 'America/New_York', isSplit: false },
  SC: { name: 'South Carolina', dominantTimezone: 'America/New_York', isSplit: false },
  SD: { name: 'South Dakota', dominantTimezone: 'America/Chicago', isSplit: true },
  TN: { name: 'Tennessee', dominantTimezone: 'America/Chicago', isSplit: true },
  TX: { name: 'Texas', dominantTimezone: 'America/Chicago', isSplit: true },
  UT: { name: 'Utah', dominantTimezone: 'America/Denver', isSplit: false },
  VT: { name: 'Vermont', dominantTimezone: 'America/New_York', isSplit: false },
  VA: { name: 'Virginia', dominantTimezone: 'America/New_York', isSplit: false },
  WA: { name: 'Washington', dominantTimezone: 'America/Los_Angeles', isSplit: false },
  WV: { name: 'West Virginia', dominantTimezone: 'America/New_York', isSplit: false },
  WI: { name: 'Wisconsin', dominantTimezone: 'America/Chicago', isSplit: false },
  WY: { name: 'Wyoming', dominantTimezone: 'America/Denver', isSplit: false },
};

// Normalize state name to 2-letter uppercase abbreviation
export function normalizeStateCode(input?: string | null): string | null {
  if (!input) return null;
  const clean = input.trim().toUpperCase();
  if (clean.length === 2 && US_STATES[clean]) {
    return clean;
  }
  const cleanLower = input.trim().toLowerCase();
  for (const [code, info] of Object.entries(US_STATES)) {
    if (info.name.toLowerCase() === cleanLower) {
      return code;
    }
  }
  return null;
}

/**
 * Specific cities in split states that have unambiguous timezone mappings
 */
const SPLIT_STATE_CITIES: Record<string, string> = {
  // Texas (dominant Central, El Paso Mountain)
  'el paso, tx': 'America/Denver',
  'anthony, tx': 'America/Denver',
  'canutillo, tx': 'America/Denver',
  'san elizario, tx': 'America/Denver',
  'socorro, tx': 'America/Denver',
  'dallas, tx': 'America/Chicago',
  'houston, tx': 'America/Chicago',
  'austin, tx': 'America/Chicago',
  'san antonio, tx': 'America/Chicago',
  'fort worth, tx': 'America/Chicago',

  // Florida (dominant Eastern, Panhandle west of Apalachicola is Central)
  'pensacola, fl': 'America/Chicago',
  'panama city, fl': 'America/Chicago',
  'crestview, fl': 'America/Chicago',
  'fort walton beach, fl': 'America/Chicago',
  'destin, fl': 'America/Chicago',
  'milton, fl': 'America/Chicago',
  'niceville, fl': 'America/Chicago',
  'miami, fl': 'America/New_York',
  'orlando, fl': 'America/New_York',
  'tampa, fl': 'America/New_York',
  'jacksonville, fl': 'America/New_York',
  'tallahassee, fl': 'America/New_York',

  // Tennessee (dominant Central, East TN is Eastern)
  'knoxville, tn': 'America/New_York',
  'chattanooga, tn': 'America/New_York',
  'johnson city, tn': 'America/New_York',
  'kingsport, tn': 'America/New_York',
  'bristol, tn': 'America/New_York',
  'cleveland, tn': 'America/New_York',
  'oak ridge, tn': 'America/New_York',
  'morristown, tn': 'America/New_York',
  'maryville, tn': 'America/New_York',
  'nashville, tn': 'America/Chicago',
  'memphis, tn': 'America/Chicago',
  'clarksville, tn': 'America/Chicago',
  'murfreesboro, tn': 'America/Chicago',
  'franklin, tn': 'America/Chicago',

  // Kentucky (dominant Eastern, West KY is Central)
  'louisville, ky': 'America/New_York',
  'lexington, ky': 'America/New_York',
  'frankfort, ky': 'America/New_York',
  'covington, ky': 'America/New_York',
  'bowling green, ky': 'America/Chicago',
  'owensboro, ky': 'America/Chicago',
  'paducah, ky': 'America/Chicago',
  'hopkinsville, ky': 'America/Chicago',

  // Indiana (dominant Eastern, Northwest and Southwest corners are Central)
  'indianapolis, in': 'America/Indiana/Indianapolis',
  'fort wayne, in': 'America/Indiana/Indianapolis',
  'bloomington, in': 'America/Indiana/Indianapolis',
  'south bend, in': 'America/Indiana/Indianapolis',
  'carmel, in': 'America/Indiana/Indianapolis',
  'gary, in': 'America/Chicago',
  'hammond, in': 'America/Chicago',
  'evansville, in': 'America/Chicago',
  'portage, in': 'America/Chicago',
  'merrillville, in': 'America/Chicago',

  // Idaho (dominant Mountain / Boise, Panhandle is Pacific)
  'boise, id': 'America/Boise',
  'meridian, id': 'America/Boise',
  'nampa, id': 'America/Boise',
  'idaho falls, id': 'America/Boise',
  'pocatello, id': 'America/Boise',
  'twin falls, id': 'America/Boise',
  'coeur d\'alene, id': 'America/Los_Angeles',
  'lewiston, id': 'America/Los_Angeles',
  'moscow, id': 'America/Los_Angeles',
  'post falls, id': 'America/Los_Angeles',

  // Michigan (dominant Eastern, 4 UP counties are Central)
  'detroit, mi': 'America/Detroit',
  'grand rapids, mi': 'America/Detroit',
  'lansing, mi': 'America/Detroit',
  'ann arbor, mi': 'America/Detroit',
  'marquette, mi': 'America/Detroit',
  'iron mountain, mi': 'America/Menominee',
  'menominee, mi': 'America/Menominee',
  'ironwood, mi': 'America/Menominee',

  // South Dakota (dominant Central, West is Mountain)
  'sioux falls, sd': 'America/Chicago',
  'rapid city, sd': 'America/Denver',
  'spearfish, sd': 'America/Denver',

  // North Dakota (dominant Central, West is Mountain)
  'fargo, nd': 'America/Chicago',
  'bismarck, nd': 'America/Chicago',
  'dickinson, nd': 'America/Denver',
  'williston, nd': 'America/Denver',

  // Nebraska (dominant Central, Panhandle is Mountain)
  'omaha, ne': 'America/Chicago',
  'lincoln, ne': 'America/Chicago',
  'scottsbluff, ne': 'America/Denver',
  'sidney, ne': 'America/Denver',

  // Kansas (dominant Central, 4 Western counties Mountain)
  'wichita, ks': 'America/Chicago',
  'overland park, ks': 'America/Chicago',
  'goodland, ks': 'America/Denver',

  // Oregon (dominant Pacific, Malheur County Mountain)
  'portland, or': 'America/Los_Angeles',
  'eugene, or': 'America/Los_Angeles',
  'salem, or': 'America/Los_Angeles',
  'ontario, or': 'America/Boise',
};

/**
 * Priority 2: 5-digit US ZIP Code lookup
 */
export function lookupTimezoneByZip(zipInput?: string | null): string | null {
  if (!zipInput) return null;
  const match = String(zipInput).trim().match(/^(\d{5})/);
  if (!match) return null;
  const zip = parseInt(match[1], 10);
  const prefix3 = Math.floor(zip / 100);

  // Specific 3-digit and 5-digit exceptions
  // Florida Panhandle (324, 325) -> Central
  if (prefix3 === 324 || prefix3 === 325) return 'America/Chicago';

  // Tennessee East (376-379) -> Eastern
  if (prefix3 >= 376 && prefix3 <= 379) return 'America/New_York';

  // Kentucky Central (420-427) -> Central
  if (prefix3 >= 420 && prefix3 <= 427) return 'America/Chicago';

  // Indiana Central (Northwest 463-464, Southwest 475-477) -> Central
  if (prefix3 === 463 || prefix3 === 464 || (prefix3 >= 475 && prefix3 <= 477)) {
    return 'America/Chicago';
  }

  // Michigan Central (Dickinson, Gogebic, Iron, Menominee: 498-499) -> check specific ranges
  if (zip >= 49801 && zip <= 49896 && [49801, 49802, 49838, 49847, 49852, 49853, 49858, 49861, 49870, 49874, 49876, 49892, 49893, 49896].includes(zip)) {
    return 'America/Menominee';
  }
  if (zip >= 49911 && zip <= 49969 && [49911, 49920, 49935, 49938, 49947, 49953, 49967, 49968].includes(zip)) {
    return 'America/Menominee';
  }

  // South Dakota West (577) -> Mountain
  if (prefix3 === 577) return 'America/Denver';

  // North Dakota West (586-588) -> Mountain
  if (prefix3 >= 586 && prefix3 <= 588) return 'America/Denver';

  // Kansas West (677-679) -> Mountain
  if (prefix3 >= 677 && prefix3 <= 679) return 'America/Denver';

  // Nebraska West (691-693) -> Mountain
  if (prefix3 >= 691 && prefix3 <= 693) return 'America/Denver';

  // Texas El Paso & Hudspeth (798, 799) -> Mountain
  if (prefix3 === 798 || prefix3 === 799) return 'America/Denver';

  // Idaho North (Panhandle: 835, 838) -> Pacific
  if (prefix3 === 835 || prefix3 === 838) return 'America/Los_Angeles';

  // Oregon Malheur County (979) -> Mountain
  if (prefix3 === 979) return 'America/Boise';

  // Standard 3-digit / 5-digit block ranges:
  if (zip >= 600 && zip <= 999) return 'America/Puerto_Rico';
  if (zip >= 1000 && zip <= 6999) return 'America/New_York'; // CT, MA, ME, NH, RI, VT
  if (zip >= 7000 && zip <= 8999) return 'America/New_York'; // NJ
  if (zip >= 9000 && zip <= 9999) return 'America/New_York'; // Military APO/FPO NY
  if (zip >= 10000 && zip <= 14999) return 'America/New_York'; // NY
  if (zip >= 15000 && zip <= 19699) return 'America/New_York'; // PA
  if (zip >= 19700 && zip <= 19999) return 'America/New_York'; // DE
  if (zip >= 20000 && zip <= 20599) return 'America/New_York'; // DC
  if (zip >= 20600 && zip <= 21999) return 'America/New_York'; // MD
  if (zip >= 22000 && zip <= 24699) return 'America/New_York'; // VA
  if (zip >= 24700 && zip <= 26999) return 'America/New_York'; // WV
  if (zip >= 27000 && zip <= 28999) return 'America/New_York'; // NC
  if (zip >= 29000 && zip <= 29999) return 'America/New_York'; // SC
  if (zip >= 30000 && zip <= 31999) return 'America/New_York'; // GA
  if (zip >= 32000 && zip <= 34999) return 'America/New_York'; // FL (non-panhandle)
  if (zip >= 35000 && zip <= 36999) return 'America/Chicago';  // AL
  if (zip >= 37000 && zip <= 38599) return 'America/Chicago';  // TN (Central)
  if (zip >= 38600 && zip <= 39799) return 'America/Chicago';  // MS
  if (zip >= 39800 && zip <= 39999) return 'America/New_York'; // GA
  if (zip >= 40000 && zip <= 41999) return 'America/New_York'; // KY (Eastern)
  if (zip >= 43000 && zip <= 45999) return 'America/New_York'; // OH
  if (zip >= 46000 && zip <= 47999) return 'America/Indiana/Indianapolis'; // IN
  if (zip >= 48000 && zip <= 49999) return 'America/Detroit';  // MI
  if (zip >= 50000 && zip <= 52899) return 'America/Chicago';  // IA
  if (zip >= 53000 && zip <= 54999) return 'America/Chicago';  // WI
  if (zip >= 55000 && zip <= 56799) return 'America/Chicago';  // MN
  if (zip >= 57000 && zip <= 57699) return 'America/Chicago';  // SD (East)
  if (zip >= 58000 && zip <= 58599) return 'America/Chicago';  // ND (East)
  if (zip >= 59000 && zip <= 59999) return 'America/Denver';   // MT
  if (zip >= 60000 && zip <= 62999) return 'America/Chicago';  // IL
  if (zip >= 63000 && zip <= 65899) return 'America/Chicago';  // MO
  if (zip >= 66000 && zip <= 67699) return 'America/Chicago';  // KS (East)
  if (zip >= 68000 && zip <= 69099) return 'America/Chicago';  // NE (East)
  if (zip >= 70000 && zip <= 71499) return 'America/Chicago';  // LA
  if (zip >= 71600 && zip <= 72999) return 'America/Chicago';  // AR
  if (zip >= 73000 && zip <= 74999) return 'America/Chicago';  // OK
  if (zip >= 75000 && zip <= 79799) return 'America/Chicago';  // TX (Central)
  if (zip >= 80000 && zip <= 81699) return 'America/Denver';   // CO
  if (zip >= 82000 && zip <= 83199) return 'America/Denver';   // WY
  if (zip >= 83200 && zip <= 83499) return 'America/Boise';    // ID (South)
  if (zip >= 83600 && zip <= 83799) return 'America/Boise';    // ID (Boise)
  if (zip >= 84000 && zip <= 84799) return 'America/Denver';   // UT
  if (zip >= 85000 && zip <= 86599) return 'America/Phoenix';  // AZ
  if (zip >= 87000 && zip <= 88499) return 'America/Denver';   // NM
  if (zip >= 88900 && zip <= 89899) return 'America/Los_Angeles'; // NV
  if (zip >= 90000 && zip <= 96199) return 'America/Los_Angeles'; // CA
  if (zip >= 96700 && zip <= 96899) return 'Pacific/Honolulu'; // HI
  if (zip >= 97000 && zip <= 97899) return 'America/Los_Angeles'; // OR (non-Malheur)
  if (zip >= 98000 && zip <= 99499) return 'America/Los_Angeles'; // WA
  if (zip >= 99500 && zip <= 99999) return 'America/Anchorage';   // AK

  return null;
}

/**
 * Priority 3: City and State lookup
 */
export function lookupTimezoneByCityState(cityInput?: string | null, stateInput?: string | null): string | null {
  if (!cityInput || !stateInput) return null;
  const stateCode = normalizeStateCode(stateInput);
  if (!stateCode) return null;

  const cityClean = cityInput.trim().toLowerCase();
  const key = `${cityClean}, ${stateCode.toLowerCase()}`;

  // Check known split-state city map
  if (SPLIT_STATE_CITIES[key]) {
    return SPLIT_STATE_CITIES[key];
  }

  const stateInfo = US_STATES[stateCode];
  // If state is not split, any city in this state resolves uniquely!
  if (stateInfo && !stateInfo.isSplit) {
    return stateInfo.dominantTimezone;
  }

  return null;
}

/**
 * Priority 4: State-level fallback
 */
export function lookupTimezoneByState(stateInput?: string | null): { timezone: string; is_estimated: boolean } | null {
  const stateCode = normalizeStateCode(stateInput);
  if (!stateCode) return null;

  const stateInfo = US_STATES[stateCode];
  if (!stateInfo) return null;

  return {
    timezone: stateInfo.dominantTimezone,
    is_estimated: stateInfo.isSplit,
  };
}

/**
 * Priority 1: Full Address Geocoding hook (mockable / injectable for testing)
 */
export type AddressGeocoderFn = (fullAddress: string) => Promise<string | null>;

let customAddressGeocoder: AddressGeocoderFn | null = null;

export function setCustomAddressGeocoder(fn: AddressGeocoderFn | null) {
  customAddressGeocoder = fn;
}

/**
 * Attempts real geocoding for full street address using US Census Geocoder API
 * with a quick timeout fallback.
 */
async function defaultAddressGeocoder(fullAddress: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);
    const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(
      fullAddress
    )}&benchmark=Public_AR_Current&format=json`;

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data: any = await res.json();
    const matches = data?.result?.addressMatches;
    if (!Array.isArray(matches) || matches.length === 0) return null;

    const coords = matches[0]?.coordinates;
    const matchedAddress = matches[0]?.matchedAddress || '';
    if (coords && typeof coords.x === 'number' && typeof coords.y === 'number') {
      const lon = coords.x;
      const lat = coords.y;

      // Extract state from matchedAddress or coordinates
      const stateMatch = matchedAddress.match(/,\s*([A-Z]{2})\s*,\s*\d{5}/i);
      const stateCode = stateMatch ? stateMatch[1].toUpperCase() : null;

      // Check ZIP from match
      const zipMatch = matchedAddress.match(/\b\d{5}\b/);
      if (zipMatch) {
        const zipTz = lookupTimezoneByZip(zipMatch[0]);
        if (zipTz) return zipTz;
      }

      // If state is known
      if (stateCode && US_STATES[stateCode]) {
        const stateInfo = US_STATES[stateCode];
        if (!stateInfo.isSplit) {
          return stateInfo.dominantTimezone;
        }
      }

      // Approximate standard US longitude bands
      if (lon >= -85.5) return 'America/New_York';
      if (lon >= -102.0) return 'America/Chicago';
      if (lon >= -115.0) return 'America/Denver';
      return 'America/Los_Angeles';
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Centralized Timezone Resolution Service
 *
 * Implements the 5-level hierarchy:
 * Priority 1: Full Address Geocoding (customer_address, is_estimated: false)
 * Priority 2: 5-digit US Postal Code Lookup (zip_code, is_estimated: false)
 * Priority 3: City and State Lookup (city_state, is_estimated: false)
 * Priority 4: State-Level Fallback (state: false, or state_estimate: true)
 * Priority 5: System Default Timezone (system_default, is_estimated: false)
 */
export async function resolveCustomerTimezone(
  addressInput: CustomerAddressInput,
  defaultTimezone: string = 'America/New_York'
): Promise<ResolvedTimezone> {
  const address = addressInput.address?.trim() || '';
  const city = addressInput.city?.trim() || '';
  const state = addressInput.state?.trim() || '';
  const zip = addressInput.zip?.trim() || '';

  // Generate cache key
  const cacheKey = `${[address, city, state, zip].map((s) => s.toLowerCase()).join('|')}|${defaultTimezone}`;
  if (timezoneResolutionCache.has(cacheKey)) {
    return timezoneResolutionCache.get(cacheKey)!;
  }

  // Priority 1: Full Address Geocoding
  // Attempt when full street address is present (street line + city/state or zip)
  const hasFullAddress = address.length > 0 && ((city.length > 0 && state.length > 0) || zip.length > 0);
  if (hasFullAddress) {
    const fullAddressString = [address, city, state, zip].filter(Boolean).join(', ');
    try {
      const geocoder = customAddressGeocoder || defaultAddressGeocoder;
      const geocodedTz = await geocoder(fullAddressString);
      if (geocodedTz) {
        const result: ResolvedTimezone = {
          timezone: geocodedTz,
          source: 'customer_address',
          is_estimated: false,
        };
        timezoneResolutionCache.set(cacheKey, result);
        return result;
      }
    } catch (err) {
      logger.debug?.(`[TimezoneService] Address geocoding error: ${err}`);
    }
  }

  // Priority 2: 5-digit US Postal Code Lookup
  if (zip) {
    const zipTz = lookupTimezoneByZip(zip);
    if (zipTz) {
      const result: ResolvedTimezone = {
        timezone: zipTz,
        source: 'zip_code',
        is_estimated: false,
      };
      timezoneResolutionCache.set(cacheKey, result);
      return result;
    }
  }

  // Priority 3: City and State Lookup
  if (city && state) {
    const cityStateTz = lookupTimezoneByCityState(city, state);
    if (cityStateTz) {
      const result: ResolvedTimezone = {
        timezone: cityStateTz,
        source: 'city_state',
        is_estimated: false,
      };
      timezoneResolutionCache.set(cacheKey, result);
      return result;
    }
  }

  // Priority 4: State-Level Fallback
  if (state) {
    const stateResult = lookupTimezoneByState(state);
    if (stateResult) {
      const result: ResolvedTimezone = {
        timezone: stateResult.timezone,
        source: stateResult.is_estimated ? 'state_estimate' : 'state',
        is_estimated: stateResult.is_estimated,
      };
      timezoneResolutionCache.set(cacheKey, result);
      return result;
    }
  }

  // Priority 5: System Default Timezone
  const result: ResolvedTimezone = {
    timezone: defaultTimezone || 'America/New_York',
    source: 'system_default',
    is_estimated: false,
  };
  timezoneResolutionCache.set(cacheKey, result);
  return result;
}

/**
 * Evaluates whether a given date falls within the allowed calling days and calling hours
 * in the customer's resolved local timezone.
 */
export function isWithinAllowedCallingWindow(
  date: Date = new Date(),
  options: CallingWindowOptions
): boolean {
  try {
    const { windowStart, windowEnd, callDays, timezone } = options;

    // 1. Day of the week in customer's local timezone
    const dayFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short', // 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'
    });
    const customerDayOfWeek = dayFormatter.format(date);

    const allowedDays = Array.isArray(callDays) && callDays.length > 0
      ? callDays
      : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

    if (!allowedDays.includes(customerDayOfWeek)) {
      return false;
    }

    // 2. Calling hours in customer's local timezone
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = timeFormatter.formatToParts(date);
    const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '12';
    const minutePart = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const currentMinutes = parseInt(hourPart, 10) * 60 + parseInt(minutePart, 10);

    const [startH, startM] = (windowStart || '10:00').split(':').map((v) => parseInt(v, 10));
    const [endH, endM] = (windowEnd || '19:00').split(':').map((v) => parseInt(v, 10));

    const startMinutes = (startH || 10) * 60 + (startM || 0);
    const endMinutes = (endH || 19) * 60 + (endM || 0);

    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  } catch (err) {
    logger.warn?.(`[TimezoneService] Error evaluating calling window: ${err}`);
    return true;
  }
}

/**
 * Formats a scheduled date in the customer's local timezone for queue display and verification.
 */
export function formatScheduledTimeInCustomerTimezone(
  dateInput: Date | string,
  timezone: string = 'America/New_York',
  source: TimezoneSource = 'system_default',
  isEstimated: boolean = false
) {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;

  // Local date e.g. "20 Sept 2026" or "Sep 20, 2026"
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const localDate = dateFormatter.format(date);

  // Local time e.g. "21:46" (24h) or "09:46 PM"
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const localTime = timeFormatter.format(date);

  // Timezone abbreviation (e.g. EST, EDT, CST, CDT, PST, PDT)
  const tzFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'short',
  });
  const tzParts = tzFormatter.formatToParts(date);
  const tzAbbr = tzParts.find((p) => p.type === 'timeZoneName')?.value || timezone;

  // Badge text
  let badgeLabel = 'Default Timezone';
  let badgeVariant: 'default' | 'customer' = 'default';

  if (source !== 'system_default') {
    badgeVariant = 'customer';
    badgeLabel = isEstimated ? 'Customer Timezone · Estimated' : 'Customer Timezone';
  }

  return {
    localDate,
    localTime,
    tzAbbr,
    badgeLabel,
    badgeVariant,
    timezone,
  };
}
