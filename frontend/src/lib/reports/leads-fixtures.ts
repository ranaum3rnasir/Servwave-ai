/**
 * Leads report fixtures - the deterministic demo dataset and the domain vocab
 * the filter panel offers.
 *
 * Extracted verbatim from `pages/reports/LeadsReport.tsx` so `leads-data.ts`
 * (the hook that serves these to a demo org and the live API to a real org) can
 * reach them without importing a page. The `Lead` type is the report's row
 * contract and is shared with the live DTO rehydration, so it lives here too.
 */
import { hashStr, mulberry32 } from './random';

// ── Domain vocab (Northwind Services) ─────────────────────────────────────────
export const STATUSES = ['Open', 'Converted', 'Sold', 'Sold-done', 'Lost'] as const;
export type Status = (typeof STATUSES)[number];
// Statuses that count as a win for the conversion KPIs.
export const WON_STATUSES: Status[] = ['Converted', 'Sold', 'Sold-done'];

export const SOURCES = [
  'Office', 'Google', 'Account', 'Returning customer', 'Village',
  'Village - Returned Customer', 'Google Local Service', 'Reserve with Google', 'Return Customer',
];
export const TEAM = ['Emanuel Dahan', 'Dispatch', 'Ohad', 'Rami', 'Logistics', 'Nadia', 'Shaked', 'Liran - Dor', 'Ofir Sub'];
export const CREATORS = ['Emanuel Dahan', 'Dispatch', 'Ohad', 'Rami', 'Logistics', 'Nadia', 'Robert Bresnick', 'Efrain & Zhao', 'Onboarding'];
export const TAGS = [
  'Followup', 'Callback', 'NEED TO COLLECT', 'NOT ANSWERING', 'NEED TO ORDER PART',
  'Waiting for pictures', 'Waiting for the client', 'Need more info', 'Today job',
];
export const JOB_TYPES = [
  'AV + NETWORK + CCTV', 'Access Control System', 'Access control', 'Alarm System', 'Bullet Proof',
  'Burglar Alarm', 'Business Lockout', 'Buzzer System', 'CALL BACK', 'Gate', 'Garage', 'Troubleshoot',
  'Commercial', 'Residential',
];

export const CLIENTS: [string, string][] = [
  ['Jessica Mills', 'jmills@gmail.com'],
  ['Jenny Park', 'jpark@yahoo.com'],
  ['Diogo Silva', 'dsilva@hotmail.com'],
  ['Brett Owens', 'bowens@gmail.com'],
  ['Jasmine Lee', 'jlee@outlook.com'],
  ['Marcus Bell', 'mbell@bell.com'],
  ['Sofia Reyes', 'sreyes@gmail.com'],
  ['Devon Clark', 'dclark@clark.net'],
  ['Priya Nair', 'pnair@nair.io'],
  ['Tyler Brooks', 'tbrooks@gmail.com'],
  ['Aisha Khan', 'akhan@khan.com'],
  ['Omar Said', 'osaid@gmail.com'],
  ['Tina Brooks', 'tbrooks2@brooks.com'],
  ['Leo Marsh', 'lmarsh@marsh.io'],
  ['Dana Cole', 'dcole@cole.com'],
  ['Robin Shah', 'rshah@shah.com'],
  ['Casey Lee', 'clee@lee.com'],
  ['Alex Ng', 'ang@ng.com'],
  ['Sam Ortiz', 'sortiz@ortiz.com'],
  ['Jordan Mills', 'jordanm@mills.com'],
];

export const STREETS = ['Mechanic St', 'Washington Ave', 'Perry St', 'Newbury St', 'Central Ave', 'Bedford Ave', 'Kings Hwy', 'Bay Ridge Ave'];
export const CITIES = ['Brooklyn, NY', 'Queens, NY', 'Bronx, NY', 'Manhattan, NY', 'Jersey City, NJ', 'Boston, MA', 'Chicago, IL'];

// ── Mock data ────────────────────────────────────────────────────────────────
export interface Lead {
  leadNumber: number;
  client: string;
  email: string;
  phone: string;
  address: string;
  status: Status;
  source: string;
  assigned: string;
  createdBy: string;
  tags: string[];
  jobType: string;
  estimates: number;
  createdAt: Date;
  scheduledAt: Date;
  convertedAt: Date | null;
  value: number;
}

const pick = <T,>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;

function buildLeads(): Lead[] {
  const rng = mulberry32(hashStr('alpha-leads-report'));
  const now = new Date();
  const leads: Lead[] = [];
  const N = 72;
  for (let i = 0; i < N; i++) {
    const [client, email] = pick(rng, CLIENTS);
    const status = pick(rng, STATUSES);
    const created = new Date(now);
    created.setDate(now.getDate() - Math.floor(rng() * 45));
    created.setHours(7 + Math.floor(rng() * 11), Math.floor(rng() * 60), 0, 0);
    const scheduled = new Date(created);
    scheduled.setDate(created.getDate() + Math.floor(rng() * 5));
    const won = WON_STATUSES.includes(status);
    const convertedAt = won ? new Date(scheduled.getTime() + Math.floor(rng() * 4) * 86400000) : null;
    const value = won ? Math.round((800 + rng() * 11000) / 10) * 10 : 0;

    const tagCount = rng() < 0.5 ? (rng() < 0.5 ? 1 : 2) : 0;
    const tags: string[] = [];
    for (let t = 0; t < tagCount; t++) {
      const tag = pick(rng, TAGS);
      if (!tags.includes(tag)) tags.push(tag);
    }

    leads.push({
      leadNumber: 17680 - i,
      client,
      email: rng() < 0.5 ? email : '',
      phone: `(${201 + Math.floor(rng() * 700)}) ${100 + Math.floor(rng() * 899)}-${1000 + Math.floor(rng() * 8999)}`,
      address: `${100 + Math.floor(rng() * 1800)} ${pick(rng, STREETS)}, ${pick(rng, CITIES)}`,
      status,
      source: pick(rng, SOURCES),
      assigned: rng() < 0.85 ? pick(rng, TEAM) : '',
      createdBy: pick(rng, CREATORS),
      tags,
      jobType: pick(rng, JOB_TYPES),
      estimates: rng() < 0.4 ? 1 + Math.floor(rng() * 3) : 0,
      createdAt: created,
      scheduledAt: scheduled,
      convertedAt,
      value,
    });
  }
  return leads;
}

// Deterministic demo leads — the `useLeadsReport` hook serves these to demo orgs
// and swaps in GET /api/reports/leads for real orgs.
export const LEADS = buildLeads();
