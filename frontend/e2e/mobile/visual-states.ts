/**
 * The phone visual baselines' one list (mobile slice 74, PRD module 12, story 148): which screens
 * are photographed, on which three phones, and what each photograph is called on disk.
 *
 * Pure data, no Playwright runtime: `src/__tests__/phone-visual-baselines.test.ts` reads it to keep
 * the committed PNGs, the package scripts and the promotion checklist in step with it.
 */
import type { OverlayKind } from './routes';

/** The three baseline devices: the narrowest phone (320), a common one (393) and one landscape size. */
export const VISUAL_DEVICES = [
  { id: 'iphone-se', kind: 'portrait' },
  { id: 'iphone-15', kind: 'portrait' },
  { id: 'landscape-phone', kind: 'landscape' },
] as const;
export type VisualDeviceId = (typeof VISUAL_DEVICES)[number]['id'];

/** What the baseline run seeds, in its own throwaway org: fixed literals, so a fresh org always numbers 1, 2, 3. */
export interface VisualFixtures {
  organizationId: string;
  customerId: string;
  /** A contacted lead with no estimate (the page with Mark Lost, Cancel and the status control). */
  leadId: string;
  /** A SENT estimate and the public link's token. */
  estimateOpen: { id: string; token: string };
  /** A SENT invoice with one partial payment, and the public link's token. */
  invoiceOpen: { id: string; token: string };
  jobId: string;
  /** A draft automation with no steps, never enabled. */
  automationId: string;
}

/** An overlay on a baseline page: one of the gate's openers, or one only the baselines open. */
export type VisualOverlay = OverlayKind | 'markLost';

/** Screens whose data the spec answers itself (a throwaway org has no text threads). */
export type VisualDoubles = 'texts';

export interface VisualState {
  /** Names the PNG files. `~` joins a page to the overlay opened on it, as in routes.ts. */
  id: string;
  /** The slice that put this screen on the baselines (the layout it protects). */
  slice: string;
  path: (f: VisualFixtures) => string;
  /** Logged out, cold open (the customer's public pages). */
  anon?: boolean;
  overlay?: VisualOverlay;
  doubles?: VisualDoubles;
  /**
   * A bounded page (its own panes scroll, the page does not): photographed at the phone's real size,
   * like an overlay, because growing the viewport would only stretch a pane that is meant to scroll.
   */
  viewportOnly?: boolean;
}

const pub = (kind: 'invoices' | 'estimates', r: { id: string; token: string }) => `/p/${kind}/${r.id}?token=${encodeURIComponent(r.token)}`;
const fixed = (p: string) => () => p;

/** The thread the text-messages double opens (see phone-visual.spec.ts). */
export const VISUAL_THREAD_ID = 'baseline-thread-1';

export const VISUAL_STATES: VisualState[] = [
  // Slice 28: the customer's public estimate and invoice, readable and actionable at 320.
  { id: 'public-estimate-open', slice: '28', anon: true, path: (f) => pub('estimates', f.estimateOpen) },
  { id: 'public-estimate-open~declineDialog', slice: '28', anon: true, path: (f) => pub('estimates', f.estimateOpen), overlay: 'declineDialog' },
  { id: 'public-invoice-open', slice: '28', anon: true, path: (f) => pub('invoices', f.invoiceOpen) },
  // Slice 55: the one detail header on customer, invoice, estimate, lead and automation builder (and the job).
  { id: 'customer-detail', slice: '55', path: (f) => `/customers/${f.customerId}` },
  { id: 'lead-detail', slice: '55', path: (f) => `/leads/${f.leadId}` },
  { id: 'estimate-detail', slice: '55', path: (f) => `/estimates/${f.estimateOpen.id}` },
  { id: 'invoice-detail', slice: '55', path: (f) => `/invoices/${f.invoiceOpen.id}` },
  { id: 'job-detail', slice: '55', path: (f) => `/jobs/${f.jobId}` },
  { id: 'automation-detail', slice: '55', path: (f) => `/automations/${f.automationId}` },
  // Slice 65: every dialog on the adaptive overlay (a sheet, a full-screen form, a card).
  { id: 'lead-detail~statusChoice', slice: '65', path: (f) => `/leads/${f.leadId}`, overlay: 'statusChoice' },
  { id: 'lead-detail~markLost', slice: '65', path: (f) => `/leads/${f.leadId}`, overlay: 'markLost' },
  { id: 'customers~drawer', slice: '65', path: fixed('/customers'), overlay: 'drawer' },
  // Slice 69: text messages, one pane at a time below md.
  { id: 'comm-text', slice: '69', path: fixed('/communication/text'), doubles: 'texts', viewportOnly: true },
  { id: 'comm-text~thread', slice: '69', path: fixed(`/communication/text?threadId=${VISUAL_THREAD_ID}`), doubles: 'texts', viewportOnly: true },
  // The lists (cards below md).
  { id: 'customers', slice: 'lists', path: fixed('/customers') },
  { id: 'invoices', slice: 'lists', path: fixed('/invoices') },
];

export const stateIds = () => VISUAL_STATES.map((s) => s.id);

/**
 * The photographs one state yields on a device, by name. A portrait phone gets the whole page in one
 * tall image (`<id>`); a page that is an overlay, and the landscape phone, get the screen as the
 * phone shows it (`<id>-top`), and the landscape phone also the scrolled-to-the-end screen
 * (`<id>-end`) when the page scrolls. The `-end` file exists only for a page that scrolls, so only the
 * first name here is promised for every state.
 */
export function baselineName(state: VisualState, part: 'whole' | 'top' | 'end'): string {
  return part === 'whole' ? state.id : `${state.id}-${part}`;
}

/** The file a snapshot is written to: `e2e/visual-baselines/phone/<name>-<device>-<platform>.png`. */
export const baselineFile = (name: string, device: VisualDeviceId, platform = 'darwin') =>
  // Playwright turns anything but letters, digits and '-' in a snapshot name into '-' (the `~` that joins a page to its overlay).
  `${name.replace(/[^A-Za-z0-9-]+/g, '-')}-${device}-${platform}.png`;

/** Whether a portrait phone gets the whole page in one tall image (else the phone's real-size screen). */
export const isWholePage = (state: VisualState) => !state.overlay && !state.viewportOnly;

/** The one file every state must have on every device, whatever its content. */
export function requiredBaseline(state: VisualState, device: (typeof VISUAL_DEVICES)[number]): string {
  const part = device.kind === 'landscape' || !isWholePage(state) ? 'top' : 'whole';
  return baselineFile(baselineName(state, part), device.id);
}
