// Dataset for the Call Tracking report. Mock-first / frontend-only: takes the
// existing 8 seed calls (which PhonePage also uses — NOT mutated here) and
// deterministically generates a larger, realistic history so search-by-date,
// search-by-client and the phone statistics feel real. Production would read
// from the telephony gateway's CallSession log instead.

import type {
  CallSession,
  CallDirection,
  CallStatus,
  AnsweredByKind,
  Sentiment,
  Disposition,
} from '@/lib/api/communication-shared/phone-calls';
import { calls as seedCalls, customers } from './call-tracking-seed';
import { hashStr, mulberry32, rangeRnd } from './random';
import type { DecoratedCall } from './call-tracking-logic';

const OFFICE_NUMBER = '+17185550100';

// Real customers from the phone mock + a few extra clients so the log has the
// breadth a 90-day call history would. Each carries the number to display.
interface ClientSeed {
  id?: string;
  name: string;
  number: string;
}

const realClients: ClientSeed[] = customers.map((c) => ({
  id: c.id,
  name: c.name,
  number: c.contacts[0]?.channels.find((ch) => ch.kind === 'phone')?.value ?? OFFICE_NUMBER,
}));

// Mirror the additional commercial accounts added to the phone-customers mock,
// so the rich CallDetailDrawer resolves their name + site for every generated
// call (ids must match phone-customers.ts).
const extraClients: ClientSeed[] = [
  { id: 'cust_sephora', name: 'Sephora SoHo', number: '+12125553311' },
  { id: 'cust_chase', name: 'Chase Branch · Midtown', number: '+19295554820' },
  { id: 'cust_wework', name: 'WeWork Bryant Park', number: '+16465557240' },
  { id: 'cust_nyu', name: 'NYU Langone Facilities', number: '+12125558890' },
  { id: 'cust_wholefoods', name: 'Whole Foods Tribeca', number: '+19175556612' },
  { id: 'cust_brooklynroasting', name: 'Brooklyn Roasting Co.', number: '+17185554409' },
  { id: 'cust_peloton', name: 'Peloton Studios NY', number: '+12125551177' },
  { id: 'cust_standard', name: 'The Standard High Line', number: '+16465552093' },
];

const clientPool: ClientSeed[] = [...realClients, ...extraClients];

const DISPOSITIONS: Disposition[] = [
  'booked',
  'quote_requested',
  'quote_given',
  'reschedule',
  'status_check',
  'billing',
  'warranty',
  'follow_up',
  'after_hours_emergency',
];

const SENTIMENTS: Sentiment[] = ['positive', 'neutral', 'negative'];

// Real agent ids from the phone-agents mock (so "Answered by" + "Agent QA"
// resolve in the detail drawer).
const CSR_AGENTS = ['agent_lena', 'agent_marco'];

const AD_SOURCES = [
  'Google Ads · Locksmith',
  'Google Ads · Access Control',
  'Yelp',
  'Facebook · HVAC',
  'Organic · Main line',
  'Referral',
  'Direct Mail',
];

// Routing rules for connected/answered calls (voicemail + outbound are handled
// separately below, so they're not in this random pool).
const CALL_FLOWS = [
  'Main IVR → CSR',
  'Forward to Emanuel',
  'AI Receptionist',
  'AI Receptionist → On-call',
];

const SUMMARIES = [
  'Customer confirmed appointment window and requested a COI before arrival.',
  'Discussed estimate revisions; customer reviewing internally, decision next week.',
  'Quick status check on an open job — gave ETA and crew name.',
  'Billing question on the last invoice; explained line items, no dispute.',
  'Warranty inquiry on prior install; logged and routed to service.',
  'Reschedule requested due to building access; moved to next available slot.',
  'New quote request for a lock retrofit; captured scope and site details.',
  'After-hours emergency triaged and escalated to the on-call tech.',
  'Returned a missed call and booked a site walk.',
];

const TRANSCRIPTS = [
  '…yes that window works, can you send the certificate of insurance ahead of time…',
  '…I will send the revised estimate today, take a look and we can lock a date…',
  '…just checking where things stand on the install for next week…',
  '…I had a question about the last invoice, the second line item…',
  '…the unit you put in last spring is making a noise again…',
  '…can we push to Thursday, building access is tight on Tuesday…',
  '…we need a quote for re-keying the back entrance and two interior doors…',
  '…the vault door is not throwing the bolt and we close soon, we need someone…',
];

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)] ?? arr[0]!;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Decorate a raw seed call with its resolved client display name. */
function decorateSeed(c: CallSession): DecoratedCall {
  const customer = customers.find((x) => x.id === c.customerId);
  const clientName = customer?.name ?? 'Unknown caller';
  return { ...c, clientName };
}

/**
 * Build the full call history for the report: the 8 real seeds plus ~90
 * generated records spread across the last 90 days from `now`. Deterministic
 * for a given `now` (seeded RNG), date-sorted newest-first.
 */
export function buildCalls(now: Date, count = 90): DecoratedCall[] {
  const rng = mulberry32(hashStr('call-tracking-summary'));
  const generated: DecoratedCall[] = [];

  for (let i = 0; i < count; i++) {
    const client = pick(rng, clientPool);
    const direction: CallDirection = rng() < 0.72 ? 'inbound' : 'outbound';

    // Outcome distribution: mostly completed, some missed / voicemail.
    const roll = rng();
    let status: CallStatus;
    if (roll < 0.7) status = 'completed';
    else if (roll < 0.86) status = 'missed';
    else status = 'voicemail';

    const answeredBy: { kind: AnsweredByKind; id?: string } =
      status === 'missed'
        ? { kind: 'none' }
        : status === 'voicemail'
          ? { kind: 'voicemail' }
          : direction === 'outbound'
            ? { kind: 'csr', id: pick(rng, CSR_AGENTS) }
            : rng() < 0.75
              ? { kind: 'csr', id: pick(rng, CSR_AGENTS) }
              : { kind: 'ai', id: 'agent_ai_rosa' };

    const hasDuration = status !== 'missed';
    const durationSec = hasDuration
      ? status === 'voicemail'
        ? Math.round(rangeRnd(rng, 18, 70))
        : Math.round(rangeRnd(rng, 45, 620))
      : undefined;

    const disposition: Disposition =
      status === 'missed' ? 'follow_up' : pick(rng, DISPOSITIONS);

    const booked = disposition === 'booked';
    // Job reference for booked / quoted calls (mirrors the seed "J-####" style).
    const jobLabel = booked
      ? `J-${1900 + i}`
      : disposition === 'quote_given' || disposition === 'quote_requested'
        ? 'Lead'
        : undefined;
    const callFlow =
      status === 'voicemail'
        ? 'Voicemail'
        : direction === 'outbound'
          ? 'Outbound · CSR'
          : answeredBy.kind === 'ai'
            ? 'AI Receptionist'
            : pick(rng, CALL_FLOWS);
    const revenue = booked
      ? Math.round(rangeRnd(rng, 280, 9800) * 100) / 100
      : disposition === 'quote_given' && rng() < 0.4
        ? Math.round(rangeRnd(rng, 90, 600) * 100) / 100
        : 0;

    // Recordings: ~75% of answered/voicemail calls; never for missed.
    const hasRecording = status !== 'missed' && rng() < 0.78;

    const startedAt = new Date(now.getTime() - rng() * 90 * DAY_MS).toISOString();

    generated.push({
      id: `ctcall_${i.toString().padStart(3, '0')}`,
      direction,
      fromNumber: direction === 'inbound' ? client.number : OFFICE_NUMBER,
      toNumber: direction === 'inbound' ? OFFICE_NUMBER : client.number,
      trackingSource: direction === 'inbound' ? pick(rng, AD_SOURCES) : undefined,
      status,
      answeredBy,
      startedAt,
      durationSec,
      customerId: client.id,
      jobLabel,
      disposition,
      sentiment: pick(rng, SENTIMENTS),
      summary: pick(rng, SUMMARIES),
      transcriptPreview: hasRecording ? pick(rng, TRANSCRIPTS) : undefined,
      hasRecording,
      qaScore: hasRecording ? Math.round(rangeRnd(rng, 72, 99)) : undefined,
      callFlow,
      tags: booked ? ['Booked'] : status === 'missed' ? ['Callback'] : undefined,
      revenue,
      clientName: client.name,
    });
  }

  const all = [...seedCalls.map(decorateSeed), ...generated];
  return all.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}
