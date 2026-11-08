/**
 * Jobs report fixtures - the deterministic demo dataset and the domain vocab
 * the filter panel offers.
 *
 * Extracted verbatim from `pages/reports/JobsReport.tsx` so `jobs-data.ts` (the
 * hook that serves these to a demo org and the live API to a real org) can
 * reach them without importing a page. The `Job` and `Status` types are the
 * report's row contract and are shared with the live DTO rehydration, so they
 * live here too.
 */
import { hashStr, mulberry32 } from './random';

// ── Domain vocab (Northwind Services) ─────────────────────────────────────────
export const STATUSES = [
  'Submitted',
  'In progress',
  'In progress - Scheduled',
  'On the way',
  'On site',
  'Pending',
  'Done',
  'done pending',
  'Canceled',
] as const;
export type Status = (typeof STATUSES)[number];

export const TYPES = [
  'Alarm System',
  'Burglar Alarm',
  'Access Control',
  'Buzzer System',
  'Business Lockout',
  'Bullet Proof',
  'AV + Network',
  'Gate',
  'Garage',
  'CALL BACK',
  'Troubleshoot',
  'Commercial',
  'Residential',
];

export const SOURCES = [
  'Office',
  'Google',
  'Account',
  'Returning customer',
  'Village',
  'Village - Ret',
  'Return Customer',
  'Reserve with',
];

export const ORIGINS = ['Lead', 'New'];

export const TECHS = [
  'Emanuel Dahan',
  'Ohad',
  'Rami',
  'Priya',
  'Shaked',
  'Liran-Dor',
  'Ofir Sub',
  'Adam Elkar',
  'Robert Bresnick',
];

export const CREATORS = ['Emanuel Dahan', 'Dispatch', 'Ohad', 'Rami', 'Logistics', 'Priya', 'Robert Bresnick'];

export const TAGS = [
  'Followup',
  'Callback',
  'NEED TO COLLECT',
  'NOT ANSWERING',
  'NEED TO ORDER',
  'Waiting for pickup',
  'Need more info',
  'TODAY JOB',
];

export const CLIENTS: [string, string][] = [
  ['Aiden Evans', 'ajevans@hud.gov'],
  ['LVD', 'umut@servwave.com'],
  ['Patrick Patel', 'prateshp@gmail.com'],
  ['Congregation', 'mjzwig@msn.com'],
  ['Arnesa Cengic', 'acekic@centric.com'],
  ['Robert Shaw', 'rshaw@outlook.com'],
  ['Dee Carter', 'dcarter@gmail.com'],
  ['Bao Nguyen', 'bnguyen@yahoo.com'],
  ['Ian Webb', 'iwebb@webbco.com'],
  ['Victor Hayes', 'vhayes@gmail.com'],
  ['Ana Flores', 'aflores@hotmail.com'],
  ['Greg Shaw', 'gshaw@gmail.com'],
  ['Lia Vega', 'lvega@vega.com'],
  ['Cole Bauer', 'cbauer@bauer.net'],
  ['Mara Diaz', 'mdiaz@gmail.com'],
  ['Neil Pope', 'npope@pope.org'],
  ['Sara Klein', 'sklein@klein.com'],
  ['Omar Said', 'osaid@gmail.com'],
  ['Tina Brooks', 'tbrooks@brooks.com'],
  ['Leo Marsh', 'lmarsh@marsh.io'],
];

export const STREETS = ['Main St', 'Park Ave', 'Broadway', 'Ocean Pkwy', 'Bedford Ave', '5th Ave', 'Kings Hwy', 'Bay Ridge Ave'];
export const CITIES = ['Brooklyn, NY', 'Queens, NY', 'Bronx, NY', 'Manhattan, NY', 'Jersey City, NJ', 'Newark, NJ'];

// ── Mock data ────────────────────────────────────────────────────────────────
export interface Job {
  jobNumber: number;
  jobName: string;
  client: string;
  email: string;
  phone: string;
  tags: string[];
  type: string;
  status: Status;
  tech: string[];
  createdBy: string;
  address: string;
  source: string;
  origin: string;
  createdAt: Date;
  scheduledAt: Date;
  endAt: Date;
  billed: number;
  paid: number;
  subtotal: number;
  tax: number;
  itemCost: number;
  laborCost: number;
  cardExpenses: number;
  techExpenses: number;
  tip: number;
  profit: number;
}

const pick = <T,>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;

export function buildMockJobs(): Job[] {
  const rng = mulberry32(hashStr('alpha-jobs-report'));
  const now = new Date();
  const jobs: Job[] = [];
  const N = 64;
  for (let i = 0; i < N; i++) {
    const [client, email] = pick(rng, CLIENTS);
    const status = pick(rng, STATUSES);
    // createdAt: spread across the last ~45 days
    const created = new Date(now);
    created.setDate(now.getDate() - Math.floor(rng() * 45));
    created.setHours(7 + Math.floor(rng() * 11), Math.floor(rng() * 60), 0, 0);
    const scheduled = new Date(created);
    scheduled.setDate(created.getDate() + Math.floor(rng() * 6));
    const end = new Date(scheduled);
    end.setDate(scheduled.getDate() + Math.floor(rng() * 3));

    const tagCount = rng() < 0.45 ? (rng() < 0.5 ? 1 : 2) : 0;
    const tags: string[] = [];
    for (let t = 0; t < tagCount; t++) {
      const tag = pick(rng, TAGS);
      if (!tags.includes(tag)) tags.push(tag);
    }
    const techCount = rng() < 0.25 ? 2 : 1;
    const tech: string[] = [];
    for (let t = 0; t < techCount; t++) {
      const x = pick(rng, TECHS);
      if (!tech.includes(x)) tech.push(x);
    }

    const billed = Math.round((150 + rng() * 4200) / 5) * 5;
    const done = status === 'Done';
    const paid = done ? billed : status === 'done pending' ? Math.round(billed * 0.5) : status === 'Canceled' ? 0 : Math.round(billed * rng() * 0.4);

    // Cost / expense / profit breakdown (statistics).
    const subtotal = Math.round((billed / 1.08875) * 100) / 100;
    const tax = Math.round((billed - subtotal) * 100) / 100;
    const itemCost = Math.round(subtotal * (0.15 + rng() * 0.15) * 100) / 100;
    const laborCost = Math.round(subtotal * (0.1 + rng() * 0.15) * 100) / 100;
    const techExpenses = Math.round(subtotal * (rng() * 0.05) * 100) / 100;
    const cardExpenses = Math.round(paid * 0.029 * 100) / 100;
    const tip = rng() < 0.15 ? Math.round(rng() * 50) : 0;
    const profit = Math.max(0, Math.round((subtotal - itemCost - laborCost - techExpenses - cardExpenses) * 100) / 100);

    jobs.push({
      jobNumber: 698484 - i,
      jobName: rng() < 0.4 ? (client.split(' ')[0] || '') : '',
      client,
      email,
      phone: `(${201 + Math.floor(rng() * 700)}) ${100 + Math.floor(rng() * 899)}-${1000 + Math.floor(rng() * 8999)}`,
      tags,
      type: pick(rng, TYPES),
      status,
      tech,
      createdBy: pick(rng, CREATORS),
      address: `${100 + Math.floor(rng() * 9800)} ${pick(rng, STREETS)}, ${pick(rng, CITIES)}`,
      source: pick(rng, SOURCES),
      origin: pick(rng, ORIGINS),
      createdAt: created,
      scheduledAt: scheduled,
      endAt: end,
      billed,
      paid,
      subtotal,
      tax,
      itemCost,
      laborCost,
      cardExpenses,
      techExpenses,
      tip,
      profit,
    });
  }
  return jobs;
}
