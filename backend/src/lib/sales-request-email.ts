/**
 * Body of the "Reach sales" email.
 *
 * Split out of email.ts, and pure, for one reason: the identity block is the
 * whole point of the message and it has to be testable. A sales request that
 * arrives as bare prose - "we'd like more numbers" - cannot be answered without
 * first asking who is writing and which account they are on, and the server
 * already knows both. Everything here except the subject, the message and the
 * topic is read from the authenticated session and the org row, so none of it
 * can be shaped by the sender.
 *
 * The html half is a FRAGMENT. email.ts wraps it in the shared shell so this
 * message is branded like every other one we send.
 */

/** The composer's preset topics. The label is what the inbox reads. */
export const SALES_TOPIC_LABELS = {
  upgrade: 'Upgrade their plan',
  numbers: 'Add phone numbers',
  port: 'Port an existing number',
  limits: 'Raise call / text limits',
  billing: 'Billing question',
} as const;

export type SalesTopic = keyof typeof SALES_TOPIC_LABELS;

export const SALES_TOPICS = Object.keys(SALES_TOPIC_LABELS) as [SalesTopic, ...SalesTopic[]];

export interface SalesRequestDetails {
  organization: {
    id: string;
    name: string;
    plan: string;
    isDemo: boolean;
    city: string | null;
    state: string | null;
    phone: string | null;
    /** CTM sub-account present - i.e. the phone module is actually wired up. */
    phoneModuleConnected: boolean;
    /** null when the count could not be read; never rendered as a number then. */
    userCount: number | null;
  };
  sender: {
    id: string;
    name: string | null;
    /** Their login email - the account we can look up, and where a reply goes. */
    email: string;
    role: string;
  };
  topic: SalesTopic | null;
  subject: string;
  message: string;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** ADMIN -> Admin, CUSTOM_ROLE -> Custom role. */
function roleLabel(role: string): string {
  const flat = role.replace(/_/g, ' ').trim();
  if (!flat) return 'Unknown role';
  return flat.charAt(0).toUpperCase() + flat.slice(1).toLowerCase();
}

function locationLabel(city: string | null, state: string | null): string | null {
  const parts = [city?.trim(), state?.trim()].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/**
 * The identity rows, in the order a rep reads them: who, where, on what plan,
 * and what they are asking for. A row with nothing behind it is dropped rather
 * than printed empty - an "Location: -" line is noise, not information.
 */
function rows(d: SalesRequestDetails): Array<[string, string]> {
  const { organization: org, sender } = d;
  const out: Array<[string, string]> = [];

  const planLabel = org.isDemo ? `${org.plan} (Demo org)` : org.plan;
  out.push(['Organization', org.name]);
  out.push(['Plan', planLabel]);

  const location = locationLabel(org.city, org.state);
  if (location) out.push(['Location', location]);
  if (org.userCount != null) {
    out.push(['Team size', `${org.userCount} ${org.userCount === 1 ? 'user' : 'users'}`]);
  }
  if (org.phone?.trim()) out.push(['Org phone', org.phone.trim()]);
  out.push(['Phone module', org.phoneModuleConnected ? 'Connected' : 'Not connected']);

  const who = sender.name?.trim() ? `${sender.name.trim()} (${sender.email})` : sender.email;
  out.push(['Sent by', `${who} - ${roleLabel(sender.role)}`]);

  out.push(['Asking about', d.topic ? SALES_TOPIC_LABELS[d.topic] : 'Custom message']);
  out.push(['Organization ID', org.id]);
  out.push(['User ID', sender.id]);

  return out;
}

export function buildSalesRequestEmail(d: SalesRequestDetails): { text: string; html: string } {
  const detail = rows(d);

  const text = [
    'New sales request',
    '',
    ...detail.map(([label, value]) => `${label}: ${value}`),
    '',
    `Subject: ${d.subject}`,
    '',
    'Message',
    '-------',
    d.message,
  ].join('\n');

  const detailHtml = detail
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:4px 16px 4px 0;font-size:13px;color:#6b7280;white-space:nowrap;vertical-align:top;">${esc(label)}</td>
          <td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${esc(value)}</td>
        </tr>`,
    )
    .join('');

  const html = `
    <h2 style="margin:0 0 4px;font-size:22px;color:#111827;">New sales request</h2>
    <p style="margin:0 0 20px;font-size:14px;color:#6b7280;">${esc(d.subject)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        <table width="100%" cellpadding="0" cellspacing="0">${detailHtml}</table>
      </td></tr>
    </table>
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Message</p>
    <p style="margin:0;font-size:15px;color:#374151;white-space:pre-wrap;">${esc(d.message)}</p>
  `;

  return { text, html };
}
