/**
 * Activity report — in-file SAMPLE data (mock-first).
 *
 * Lets the Company → Division → Individual layout and metrics be reviewed before
 * the real backend aggregation (over the TimelineEvent log) is wired. Numbers are
 * hand-tuned to be realistic, not random, so the page reads the same every render.
 *
 * Spec: md_files/specs/activity/2026-06-07-activity-deep-dive-design.md
 */
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import type { Division, UserActivity } from './activity-logic';

export const DIVISIONS: Division[] = [
  { id: 'locksmith', name: 'Locksmith', icon: '🔐', revenueBearing: true },
  { id: 'door', name: 'Door', icon: '🚪', revenueBearing: true },
  { id: 'installers', name: 'Installers', icon: '🔧', revenueBearing: true },
  { id: 'logistics', name: 'Logistics', icon: '📦', revenueBearing: false },
];

const mins = (m: number) => m * 60;

export const USERS: UserActivity[] = [
  // ── Locksmith ───────────────────────────────────────────────────────────────
  {
    id: 'u-oved',
    name: 'Oved Adani',
    role: 'Sales',
    divisionId: 'locksmith',
    active: true,
    revenueTouched: 62000,
    prevRevenueTouched: 54000,
    conversions: 18,
    leads: 34,
    responseSec: mins(2) + 10,
    prevResponseSec: mins(3),
    reactionSec: 52,
    slaMetPct: 96,
    actions: 312,
    activeMinutes: 7 * 60 + 5,
    firstActionAt: '7:48a',
    lastActionAt: '6:53p',
    breakdown: [
      { label: 'Leads created', icon: '📋', count: 30 },
      { label: 'SMS sent', icon: '💬', count: 58 },
      { label: 'Calls made', icon: '📞', count: 81 },
      { label: 'Jobs converted', icon: '✅', count: 18 },
      { label: 'Records edited', icon: '✏️', count: 124 },
      { label: 'Payments logged', icon: '💵', count: 7, note: '$18.4k' },
    ],
    response7d: [mins(2), 95, mins(3), 70, 110, mins(2) + 30, 80],
    heatmap: [0.2, 0.6, 0.9, 1, 0.8, 0.5, 0.3],
    timeline: [
      { at: '10:41a', label: 'Converted lead to job 698540', gapNote: 'reacted 38s after estimate approved', gapTone: 'good' },
      { at: '10:22a', label: 'Sent to tech by SMS — lead 17701', gapNote: 'reacted 41s after assignment', gapTone: 'good' },
      { at: '9:58a', label: 'Created lead 17701' },
    ],
  },
  {
    id: 'u-emanuel',
    name: 'Emanuel Dahan',
    role: 'Sales',
    divisionId: 'locksmith',
    active: true,
    revenueTouched: 48200,
    prevRevenueTouched: 41000,
    conversions: 8,
    leads: 22,
    responseSec: mins(4) + 12,
    prevResponseSec: mins(5) + 6,
    reactionSec: mins(1) + 47,
    slaMetPct: 86,
    actions: 280,
    activeMinutes: 6 * 60 + 20,
    firstActionAt: '8:02a',
    lastActionAt: '6:41p',
    breakdown: [
      { label: 'Leads created', icon: '📋', count: 22 },
      { label: 'SMS sent', icon: '💬', count: 41 },
      { label: 'Calls made', icon: '📞', count: 63 },
      { label: 'Jobs converted', icon: '✅', count: 8 },
      { label: 'Records edited', icon: '✏️', count: 112 },
      { label: 'Payments logged', icon: '💵', count: 5, note: '$12.1k' },
    ],
    response7d: [mins(3), mins(2), mins(8), mins(3) + 20, 90, mins(22), mins(2) + 30],
    heatmap: [0.1, 0.5, 0.9, 1, 0.7, 0.4, 0.2],
    timeline: [
      { at: '10:38a', label: 'Sent to tech by SMS — lead 17686', gapNote: 'reacted 47s after assignment', gapTone: 'good' },
      { at: '10:38a', label: 'Created lead 17686' },
      { at: '10:08a', label: 'Added item "Scope of work" — job 698503' },
      { at: '10:06a', label: 'Converted lead to job 698503', gapNote: '3m after estimate approved', gapTone: 'warn' },
    ],
  },
  {
    id: 'u-priya',
    name: 'Priya',
    role: 'Dispatcher',
    divisionId: 'locksmith',
    active: true,
    revenueTouched: 31000,
    prevRevenueTouched: 33500,
    conversions: 9,
    leads: 28,
    responseSec: mins(9) + 2,
    prevResponseSec: mins(8),
    reactionSec: mins(3) + 10,
    slaMetPct: 71,
    actions: 190,
    activeMinutes: 6 * 60,
    firstActionAt: '8:25a',
    lastActionAt: '5:40p',
    breakdown: [
      { label: 'Leads created', icon: '📋', count: 14 },
      { label: 'SMS sent', icon: '💬', count: 33 },
      { label: 'Calls made', icon: '📞', count: 47 },
      { label: 'Jobs converted', icon: '✅', count: 9 },
      { label: 'Records edited', icon: '✏️', count: 71 },
      { label: 'Payments logged', icon: '💵', count: 3, note: '$6.2k' },
    ],
    response7d: [mins(7), mins(9), mins(6), mins(12), mins(8), mins(11), mins(9)],
    heatmap: [0.3, 0.6, 0.7, 0.6, 0.8, 0.5, 0.2],
    timeline: [
      { at: '11:02a', label: 'Sent to tech by SMS — lead 17690', gapNote: 'reacted 6m after assignment', gapTone: 'warn' },
      { at: '10:30a', label: 'Updated lead details — 17690' },
    ],
  },
  {
    id: 'u-shani',
    name: 'Shani Adani',
    role: 'Sales',
    divisionId: 'locksmith',
    active: true,
    revenueTouched: 22000,
    prevRevenueTouched: 29000,
    conversions: 4,
    leads: 24,
    responseSec: mins(21),
    prevResponseSec: mins(16),
    reactionSec: mins(7),
    slaMetPct: 48,
    actions: 96,
    activeMinutes: 4 * 60 + 30,
    firstActionAt: '9:10a',
    lastActionAt: '4:55p',
    breakdown: [
      { label: 'Leads created', icon: '📋', count: 10 },
      { label: 'SMS sent', icon: '💬', count: 18 },
      { label: 'Calls made', icon: '📞', count: 22 },
      { label: 'Jobs converted', icon: '✅', count: 4 },
      { label: 'Records edited', icon: '✏️', count: 38 },
      { label: 'Payments logged', icon: '💵', count: 1, note: '$1.9k' },
    ],
    response7d: [mins(18), mins(24), mins(15), mins(28), mins(20), mins(22), mins(19)],
    heatmap: [0.1, 0.3, 0.5, 0.4, 0.6, 0.3, 0.1],
    timeline: [
      { at: '2:14p', label: 'Created lead 17712' },
      { at: '11:50a', label: 'Sent to tech by SMS — lead 17705', gapNote: 'reacted 24m after assignment', gapTone: 'bad' },
    ],
  },
  // ── Door ──────────────────────────────────────────────────────────────────
  {
    id: 'u-richard',
    name: 'Richard',
    role: 'Sales',
    divisionId: 'door',
    active: true,
    revenueTouched: 74000,
    prevRevenueTouched: 61000,
    conversions: 21,
    leads: 41,
    responseSec: mins(3) + 40,
    prevResponseSec: mins(5),
    reactionSec: 64,
    slaMetPct: 93,
    actions: 246,
    activeMinutes: 7 * 60,
    firstActionAt: '7:55a',
    lastActionAt: '6:10p',
    breakdown: [
      { label: 'Leads created', icon: '📋', count: 26 },
      { label: 'SMS sent', icon: '💬', count: 52 },
      { label: 'Calls made', icon: '📞', count: 70 },
      { label: 'Jobs converted', icon: '✅', count: 21 },
      { label: 'Records edited', icon: '✏️', count: 98 },
      { label: 'Payments logged', icon: '💵', count: 9, note: '$24.5k' },
    ],
    response7d: [mins(4), mins(3), mins(5), mins(2) + 40, mins(3) + 30, mins(4) + 10, mins(3)],
    heatmap: [0.3, 0.7, 1, 0.9, 0.7, 0.5, 0.3],
    timeline: [
      { at: '10:50a', label: 'Converted lead to job 698561', gapNote: 'reacted 51s after estimate approved', gapTone: 'good' },
    ],
  },
  {
    id: 'u-sagiv',
    name: 'Sagiv Peker',
    role: 'Dispatcher',
    divisionId: 'door',
    active: true,
    revenueTouched: 52000,
    prevRevenueTouched: 49000,
    conversions: 12,
    leads: 30,
    responseSec: mins(6) + 30,
    prevResponseSec: mins(7),
    reactionSec: mins(2),
    slaMetPct: 84,
    actions: 168,
    activeMinutes: 6 * 60 + 10,
    firstActionAt: '8:15a',
    lastActionAt: '5:58p',
    breakdown: [
      { label: 'Leads created', icon: '📋', count: 18 },
      { label: 'SMS sent', icon: '💬', count: 39 },
      { label: 'Calls made', icon: '📞', count: 51 },
      { label: 'Jobs converted', icon: '✅', count: 12 },
      { label: 'Records edited', icon: '✏️', count: 60 },
      { label: 'Payments logged', icon: '💵', count: 4, note: '$9.8k' },
    ],
    response7d: [mins(6), mins(7), mins(5), mins(8), mins(6) + 30, mins(7), mins(6)],
    heatmap: [0.2, 0.5, 0.8, 0.7, 0.6, 0.4, 0.2],
    timeline: [{ at: '9:40a', label: 'Sent to tech by SMS — lead 17677', gapNote: 'reacted 2m after assignment', gapTone: 'good' }],
  },
  // ── Installers ──────────────────────────────────────────────────────────────
  {
    id: 'u-devon',
    name: 'Devon Clark',
    role: 'Technician',
    divisionId: 'installers',
    active: true,
    revenueTouched: 88000,
    prevRevenueTouched: 72000,
    conversions: 26,
    leads: 38,
    responseSec: mins(11),
    prevResponseSec: mins(14),
    reactionSec: mins(4),
    slaMetPct: 76,
    actions: 142,
    activeMinutes: 7 * 60 + 30,
    firstActionAt: '7:30a',
    lastActionAt: '6:20p',
    breakdown: [
      { label: 'Jobs completed', icon: '✅', count: 26 },
      { label: 'SMS sent', icon: '💬', count: 22 },
      { label: 'Calls made', icon: '📞', count: 31 },
      { label: 'Records edited', icon: '✏️', count: 49 },
      { label: 'Payments logged', icon: '💵', count: 12, note: '$31.2k' },
    ],
    response7d: [mins(10), mins(12), mins(9), mins(14), mins(11), mins(13), mins(11)],
    heatmap: [0.4, 0.7, 0.8, 0.6, 0.7, 0.6, 0.4],
    timeline: [{ at: '3:12p', label: 'Logged payment $4,200 — job 698499' }],
  },
  {
    id: 'u-tyler',
    name: 'Tyler Brooks',
    role: 'Technician',
    divisionId: 'installers',
    active: true,
    revenueTouched: 54000,
    prevRevenueTouched: 58000,
    conversions: 17,
    leads: 29,
    responseSec: mins(13),
    prevResponseSec: mins(12),
    reactionSec: mins(5) + 30,
    slaMetPct: 72,
    actions: 110,
    activeMinutes: 6 * 60 + 45,
    firstActionAt: '7:40a',
    lastActionAt: '5:30p',
    breakdown: [
      { label: 'Jobs completed', icon: '✅', count: 17 },
      { label: 'SMS sent', icon: '💬', count: 16 },
      { label: 'Calls made', icon: '📞', count: 24 },
      { label: 'Records edited', icon: '✏️', count: 41 },
      { label: 'Payments logged', icon: '💵', count: 8, note: '$19.4k' },
    ],
    response7d: [mins(12), mins(14), mins(11), mins(16), mins(13), mins(12), mins(13)],
    heatmap: [0.3, 0.6, 0.7, 0.5, 0.6, 0.5, 0.3],
    timeline: [{ at: '1:05p', label: 'Completed job 698488' }],
  },
  // ── Logistics (support — no revenue) ──────────────────────────────────────────
  {
    id: 'u-logi-1',
    name: 'Maya Stern',
    role: 'Dispatcher',
    divisionId: 'logistics',
    active: true,
    revenueTouched: 0,
    prevRevenueTouched: 0,
    conversions: 0,
    leads: 0,
    responseSec: mins(3) + 20,
    prevResponseSec: mins(4),
    reactionSec: 50,
    slaMetPct: 94,
    actions: 204,
    activeMinutes: 7 * 60,
    firstActionAt: '7:20a',
    lastActionAt: '5:15p',
    breakdown: [
      { label: 'Routes dispatched', icon: '🚚', count: 38 },
      { label: 'SMS sent', icon: '💬', count: 64 },
      { label: 'Calls made', icon: '📞', count: 42 },
      { label: 'Records edited', icon: '✏️', count: 60 },
    ],
    response7d: [mins(3), mins(4), mins(3), mins(3) + 30, mins(2) + 50, mins(4), mins(3)],
    heatmap: [0.5, 0.8, 0.7, 0.6, 0.7, 0.6, 0.4],
    timeline: [{ at: '8:05a', label: 'Dispatched route #R-204', gapNote: 'reacted 50s after job ready', gapTone: 'good' }],
  },
  {
    id: 'u-logi-2',
    name: 'Ohad',
    role: 'Dispatcher',
    divisionId: 'logistics',
    active: true,
    revenueTouched: 0,
    prevRevenueTouched: 0,
    conversions: 0,
    leads: 0,
    responseSec: mins(4) + 30,
    prevResponseSec: mins(4),
    reactionSec: 75,
    slaMetPct: 90,
    actions: 176,
    activeMinutes: 6 * 60 + 40,
    firstActionAt: '7:35a',
    lastActionAt: '5:05p',
    breakdown: [
      { label: 'Routes dispatched', icon: '🚚', count: 31 },
      { label: 'SMS sent', icon: '💬', count: 55 },
      { label: 'Calls made', icon: '📞', count: 38 },
      { label: 'Records edited', icon: '✏️', count: 52 },
    ],
    response7d: [mins(4), mins(5), mins(4), mins(4) + 30, mins(3) + 40, mins(5), mins(4)],
    heatmap: [0.4, 0.7, 0.7, 0.5, 0.6, 0.5, 0.3],
    timeline: [{ at: '8:30a', label: 'Dispatched route #R-207' }],
  },
];

// ── Real-org data (GET /api/reports/activity) ─────────────────────────────────
// There is NO division on User/TimelineEvent, so real orgs get a single flat
// actor list under one synthetic "All activity" division (the Company view still
// renders one group). The Division/Individual zoom and the money/SLA metrics are
// demo-only — they are never fabricated for real orgs.
export const REAL_DIVISIONS: Division[] = [
  { id: 'all', name: 'All activity', icon: '📊', revenueBearing: false },
];

/** Shape the backend `buildActivityReport` returns (no division, no mock arrays). */
interface ApiActivityUser {
  id: string;
  name: string;
  role: string;
  active: boolean;
  revenueTouched: number;
  prevRevenueTouched: number;
  conversions: number;
  leads: number;
  responseSec: number;
  prevResponseSec: number;
  reactionSec: number;
  slaMetPct: number;
  actions: number;
  activeMinutes: number;
  firstActionAt: string;
  lastActionAt: string;
  breakdown: { label: string; count: number }[];
}

/** Normalize an API actor into the full `UserActivity` the report renders. */
function toUserActivity(u: ApiActivityUser): UserActivity {
  return {
    ...u,
    divisionId: 'all',
    breakdown: u.breakdown.map((b) => ({ label: b.label, icon: '•', count: b.count })),
    response7d: [],
    heatmap: [],
    timeline: [],
  };
}

/**
 * Activity actors + the division set to render against.
 *  • demo org → the deterministic sample (Company→Division→Individual + money/SLA).
 *  • real org → GET /api/reports/activity (per-actor rollup of the TimelineEvent
 *    log), flattened under a single "All activity" division (no fabricated split).
 */
export function useActivityReport(isDemo: boolean): {
  users: UserActivity[];
  divisions: Division[];
  isLoading: boolean;
} {
  const live = useQuery({
    queryKey: ['activity-report'],
    queryFn: async () => {
      const { data } = await api.get('/api/reports/activity');
      return ((data.users ?? []) as ApiActivityUser[]).map(toUserActivity);
    },
    staleTime: 60_000,
    enabled: !isDemo,
  });

  if (isDemo) return { users: USERS, divisions: DIVISIONS, isLoading: false };
  return { users: live.data ?? [], divisions: REAL_DIVISIONS, isLoading: live.isLoading };
}
