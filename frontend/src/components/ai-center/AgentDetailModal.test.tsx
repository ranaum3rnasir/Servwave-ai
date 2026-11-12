import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { toast } from '@/ui-kit/components/ui/sonner';
import { renderWithProviders } from '@/__tests__/helpers';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { AI_AGENTS } from '@/lib/ai-center/agents';
import { AiCenterModal } from './AiCenterModal';

vi.mock('@/ui-kit/components/ui/sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function signIn(user: Record<string, unknown>) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user, isAuthenticated: true })) as never);
}
const NO_SPIDER = { id: 'u1', role: 'ADMIN', is_admin: true, org_is_demo: false, org_features: ['leads'] };
const SPIDER_COMPANY = { id: 'u1', role: 'ADMIN', is_admin: true, org_is_demo: true, org_features: ['leads', 'spider'] };
// SPEC-5: a real (non-demo) company on the server's Spider pilot list.
const PILOT_COMPANY = { id: 'u1', role: 'ADMIN', is_admin: true, org_is_demo: false, org_is_spider_pilot: true, org_features: ['leads', 'spider'] };
const STATUS = '/api/ai-farm/spider/status';
const mockApi = vi.mocked(api);
// The server's answer still says whether Spider was set up; the pop-up never reads it (#3433).
const ON = { isActive: true, isSetUp: true };
const OFF = { isActive: false, isSetUp: true };
const NEVER_SET_UP = { isActive: false, isSetUp: false };
const ON_NOT_SET_UP = { isActive: true, isSetUp: false };
const NOT_ACTIVE_HELP = 'Spider watches nothing and sends nothing. Open it, check the settings, then press Activate.';
/** A server whose switch moves when it is saved: the status route reads back what was put. */
function spiderServer(initial: { isActive: boolean; isSetUp: boolean }) {
  let state = { ...initial };
  spiderSwitch(state);
  mockApi.get.mockImplementation(async (url: string) => (url === STATUS ? { data: state } : { data: {} }));
  mockApi.put.mockImplementation(async (_url: string, body?: unknown) => {
    state = { ...state, isActive: (body as { isActive: boolean }).isActive };
    return { data: state };
  });
}
/** What the Spider status route answers: a state, an error, or nothing yet. */
function spiderSwitch(answer: { isActive: boolean; isSetUp: boolean } | 'error' | 'never') {
  mockApi.get.mockImplementation((url: string) => {
    if (url !== STATUS) return Promise.resolve({ data: {} });
    if (answer === 'never') return new Promise(() => {});
    if (answer === 'error') return Promise.reject(new Error('unavailable'));
    return Promise.resolve({ data: answer });
  });
}

/** Opens the catalog straight on one agent, the way a job page's AI tile does. */
function openOn(agentId: string) {
  useAiCenterStore.getState().openModal(agentId);
  renderWithProviders(<AiCenterModal />);
  return screen.getByRole('dialog', { name: AI_AGENTS.find((a) => a.id === agentId)!.name });
}

function setReducedMotion(reduce: boolean) {
  vi.mocked(window.matchMedia).mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

// A controllable IntersectionObserver: the test decides when the video slot is on screen.
type IOCallback = (entries: Array<Pick<IntersectionObserverEntry, 'isIntersecting' | 'target'>>) => void;
let observers: Array<{ cb: IOCallback; targets: Element[]; disconnected: boolean }> = [];
class FakeIntersectionObserver {
  private record: (typeof observers)[number];
  constructor(cb: IOCallback) {
    this.record = { cb, targets: [], disconnected: false };
    observers.push(this.record);
  }
  observe(el: Element) {
    this.record.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.record.disconnected = true;
  }
  takeRecords() {
    return [];
  }
}
function setOnScreen(isIntersecting: boolean) {
  act(() => {
    for (const o of observers) {
      if (!o.disconnected) o.cb(o.targets.map((target) => ({ isIntersecting, target })));
    }
  });
}
function setTabHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.put.mockReset();
  mockApi.get.mockResolvedValue({ data: {} });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  signIn(NO_SPIDER);
  setReducedMotion(false);
  observers = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  useAiCenterStore.setState({ open: false, focusAgentId: null });
});
afterEach(() => {
  setReducedMotion(false);
  setTabHidden(false);
  vi.unstubAllGlobals();
});

const heroOf = (slot: HTMLElement, motion: 'still' | 'loop') =>
  slot.querySelector<HTMLImageElement>(`img[data-motion="${motion}"]`);

describe('AgentDetailModal: the video slot', () => {
  it("plays the animal's loop while on screen, marked as a feature video still to come, with no player", () => {
    const dialog = openOn('jordan');
    const slot = within(dialog).getByTestId('agent-video-slot');
    // The still is there first; the loop joins once the slot is on screen.
    expect(heroOf(slot, 'still')?.getAttribute('src')).toBe('/ai-center/agents/still/jordan.jpg');
    expect(heroOf(slot, 'loop')).toBeNull();
    setOnScreen(true);
    expect(slot).toHaveAttribute('data-playing', 'true');
    expect(heroOf(slot, 'loop')?.getAttribute('src')).toBe('/ai-center/agents/loop/jordan.webp');
    expect(within(slot).getByText('Feature video coming soon')).toBeInTheDocument();
    // Nothing plays until a video exists: no play button, no <video>.
    expect(within(slot).queryByRole('button')).toBeNull();
    expect(dialog.querySelector('video')).toBeNull();
  });

  it('stops the loop when the slot scrolls away or the tab is hidden', () => {
    const slot = within(openOn('jordan')).getByTestId('agent-video-slot');
    setOnScreen(true);
    expect(heroOf(slot, 'loop')).not.toBeNull();
    setOnScreen(false);
    expect(heroOf(slot, 'loop')).toBeNull();
    setOnScreen(true);
    setTabHidden(true);
    expect(heroOf(slot, 'loop')).toBeNull();
    setTabHidden(false);
    expect(heroOf(slot, 'loop')).not.toBeNull();
  });

  it('shows only the still frame under reduced motion', () => {
    setReducedMotion(true);
    const slot = within(openOn('jordan')).getByTestId('agent-video-slot');
    setOnScreen(true);
    expect(slot).toHaveAttribute('data-playing', 'false');
    expect(heroOf(slot, 'still')?.getAttribute('src')).toBe('/ai-center/agents/still/jordan.jpg');
    expect(heroOf(slot, 'loop')).toBeNull();
  });

  it('keeps the still when the loop fails to load', () => {
    const slot = within(openOn('jordan')).getByTestId('agent-video-slot');
    setOnScreen(true);
    fireEvent.error(heroOf(slot, 'loop')!);
    expect(heroOf(slot, 'loop')).toBeNull();
    expect(heroOf(slot, 'still')).toHaveClass('opacity-100');
  });

  it('gives the Master Agent, which has no loop, its still portrait', () => {
    const slot = within(openOn('master')).getByTestId('agent-video-slot');
    setOnScreen(true);
    expect(heroOf(slot, 'still')?.getAttribute('src')).toBe('/ai-center/agents/master.png');
    expect(heroOf(slot, 'loop')).toBeNull();
  });
});

describe('AgentDetailModal: header and story', () => {
  it('shows the role without "AI" and in sentence case, and the tagline, intro and points', () => {
    const jordan = AI_AGENTS.find((a) => a.id === 'jordan')!;
    const dialog = openOn('jordan');
    expect(within(dialog).getByText('Estimate follow-up')).toBeInTheDocument();
    expect(within(dialog).queryByText(jordan.role)).toBeNull();
    expect(within(dialog).getByText(jordan.tagline)).toBeInTheDocument();
    expect(within(dialog).getByText(jordan.longDescription[0]!)).toBeInTheDocument();
    // The intro is a paragraph; the other six are the dotted list.
    const items = within(dialog).getAllByRole('listitem').filter((li) => !li.closest('section'));
    expect(items.map((li) => li.textContent)).toEqual(jordan.longDescription.slice(1));
  });
});

describe('AgentDetailModal: an agent the company cannot use', () => {
  it('shows "Coming soon" under the role, no control row, and a booking call', () => {
    const dialog = openOn('mike');
    const statuses = dialog.querySelectorAll('[data-agent-status]');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveTextContent('Coming soon');
    expect(dialog.querySelector('[data-agent-control-row]')).toBeNull();
    expect(within(dialog).queryByRole('switch')).toBeNull();
    expect(within(dialog).getByText('Close', { selector: 'button' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Book a call about Border Collie' })).toBeInTheDocument();
    expect(within(dialog).queryByText(/in development/i)).toBeNull();
  });

  it('keeps Spider as "Coming soon" with a booking call for a company without Spider, and asks nothing', async () => {
    const dialog = openOn('spider');
    expect(within(dialog).getByText('Coming soon')).toBeInTheDocument();
    expect(within(dialog).getByText('Book a call about Spider')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Open Spider|Set up Spider/ })).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(mockApi.get.mock.calls.filter(([u]) => String(u).includes('/spider/'))).toHaveLength(0);
  });

  it('leaves every other agent "Coming soon" in a Spider company', () => {
    signIn(SPIDER_COMPANY);
    const dialog = openOn('mike');
    expect(within(dialog).getByText('Coming soon')).toBeInTheDocument();
    expect(dialog.querySelector('[data-agent-control-row]')).toBeNull();
    expect(within(dialog).getByText('Book a call about Border Collie')).toBeInTheDocument();
  });
});

// Mockup M1 "AI Agentic Farm card and pop-up" (Ran, 10 Nov): a status row with a Not active / Active
// badge, the ? on Not active, and no switch anywhere.
describe('AgentDetailModal: the status row', () => {
  const row = (dialog: HTMLElement) => dialog.querySelector<HTMLElement>('[data-agent-control-row]');

  it.each([
    ['Active', ON],
    ['Active', ON_NOT_SET_UP],
    ['Not active', OFF],
    ['Not active', NEVER_SET_UP],
  ] as const)('an Admin sees "Status" and the %s badge, above the video, with no switch', async (words, answer) => {
    signIn(SPIDER_COMPANY);
    spiderSwitch(answer);
    const dialog = openOn('spider');
    const badge = await within(dialog).findByText(words, { selector: '[data-agent-chip]' });
    expect(within(row(dialog)!).getByText('Status')).toBeInTheDocument();
    expect(row(dialog)!.contains(badge)).toBe(true);
    // A polite live region: a screen reader hears the badge change after Deactivate.
    expect(badge.parentElement).toHaveAttribute('role', 'status');
    const slot = within(dialog).getByText('Feature video coming soon');
    expect(row(dialog)!.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).queryByRole('switch')).toBeNull();
    expect(dialog.querySelector('[data-agent-status]')).toBeNull();
    // No second line and none of the old on/off words.
    for (const old of [/Spider is (on|off)/, /Watching your open leads/, /No new lead alerts/, /not set up/i, /Turn it on/]) {
      expect(within(dialog).queryByText(old)).toBeNull();
    }
  });

  it("an Admin gets the ? beside Not active, with the mockup's words, and none beside Active", async () => {
    signIn(SPIDER_COMPANY);
    spiderSwitch(OFF);
    const user = userEvent.setup();
    const dialog = openOn('spider');
    const help = await within(dialog).findByRole('button', { name: 'About Not active' });
    expect(row(dialog)!.contains(help)).toBe(true);
    await user.click(help);
    expect(await screen.findByText(NOT_ACTIVE_HELP)).toBeInTheDocument();
  });

  it('shows no ? while Spider is Active', async () => {
    signIn(SPIDER_COMPANY);
    spiderSwitch(ON);
    const dialog = openOn('spider');
    await within(dialog).findByText('Active', { selector: '[data-agent-chip]' });
    expect(within(dialog).queryByRole('button', { name: /About/ })).toBeNull();
  });

  // A stray Space on open must not press anything, and no focus ring is drawn round the frame.
  it('opens with focus on the header, not on a control or the frame', async () => {
    signIn(SPIDER_COMPANY);
    spiderSwitch(ON);
    const dialog = openOn('spider');
    await within(dialog).findByRole('button', { name: 'Deactivate' });
    const header = dialog.querySelector<HTMLElement>('[data-agent-detail-header]')!;
    await waitFor(() => expect(header).toHaveFocus());
    expect(header).toHaveAttribute('tabindex', '-1');
    expect(header).toHaveClass('outline-none');
  });

  it('holds the row with a placeholder while the status is read', () => {
    signIn(SPIDER_COMPANY);
    spiderSwitch('never');
    const dialog = openOn('spider');
    expect(row(dialog)).toHaveAttribute('data-agent-control-row', 'loading');
    expect(row(dialog)).toHaveClass('min-h-[48px]');
    expect(row(dialog)!.textContent).toBe('');
  });

  it('claims nothing when the status cannot be read', async () => {
    signIn(SPIDER_COMPANY);
    spiderSwitch('error');
    const dialog = openOn('spider');
    await waitFor(() => expect(row(dialog)).toBeNull());
    for (const words of ['Active', 'Not active', 'On', 'Off']) {
      expect(within(dialog).queryByText(words)).toBeNull();
    }
  });
});

// SPEC-5: a pilot company gets what a demo company gets.
describe('AgentDetailModal: a company on the Spider pilot list', () => {
  it('an Admin sees the status and the way to Spider, never "Coming soon" or the booking call', async () => {
    signIn(PILOT_COMPANY);
    spiderSwitch(OFF);
    const dialog = openOn('spider');
    expect(await within(dialog).findByText('Not active', { selector: '[data-agent-chip]' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Set up Spider' })).toBeInTheDocument();
    expect(within(dialog).queryByText('Coming soon')).toBeNull();
    expect(within(dialog).queryByText('Book a call about Spider')).toBeNull();
  });
});

// Ran, 10 Nov (Q2 A, Q3 A): someone without Spider's Admin access sees the status without the buttons.
describe('AgentDetailModal: someone who may not manage Spider', () => {
  it.each([
    ['Active', 'SALES', ON],
    ['Active', 'TECHNICIAN', ON_NOT_SET_UP],
    ['Not active', 'SALES', OFF],
    ['Not active', 'TECHNICIAN', NEVER_SET_UP],
  ] as const)('sees the %s badge (%s) and no button, no ? and no switch', async (words, role, answer) => {
    signIn({ ...SPIDER_COMPANY, role, is_admin: false });
    spiderSwitch(answer);
    const dialog = openOn('spider');
    expect(await within(dialog).findByText(words, { selector: '[data-agent-chip]' })).toBeInTheDocument();
    // No footer at all (the pop-up's own X still closes it): no Close, Set up, Open, Deactivate, ? or booking call.
    expect(within(dialog).queryByText('Close', { selector: 'button' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Close' })).not.toHaveTextContent('Close');
    expect(within(dialog).queryByRole('button', { name: /Open Spider|Set up Spider|Deactivate|About|Book a call/ })).toBeNull();
    expect(within(dialog).queryByRole('switch')).toBeNull();
    expect(within(dialog).queryByText(/Spider is on for your company|An Admin turns Spider on or off/)).toBeNull();
  });
});

describe('AgentDetailModal: Deactivate from the pop-up', () => {
  it('asks first with the same question as the Spider page; "Keep it active" sends nothing', async () => {
    signIn(SPIDER_COMPANY);
    spiderSwitch(ON);
    const user = userEvent.setup();
    const dialog = openOn('spider');
    await user.click(await within(dialog).findByRole('button', { name: 'Deactivate' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Deactivate Spider?' });
    expect(within(confirm).getByText('Spider stops watching your leads and sends no new alerts. Any open Spider alerts are cleared for everyone, and Spider History keeps a record of them.')).toBeInTheDocument();
    expect(within(confirm).getByText('Your statuses, time limits and who gets alerted are all kept. When you activate it again, the review asks whether to send one summary of the leads still past their time limit.')).toBeInTheDocument();
    const keep = within(confirm).getByRole('button', { name: 'Keep it active' });
    await waitFor(() => expect(keep).toHaveFocus());
    await user.click(keep);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mockApi.put).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Active', { selector: '[data-agent-chip]' })).toBeInTheDocument();
  });

  it('"Deactivate" saves Spider Not active; the badge and the footer follow', async () => {
    signIn(SPIDER_COMPANY);
    spiderServer(ON);
    const user = userEvent.setup();
    const dialog = openOn('spider');
    await user.click(await within(dialog).findByRole('button', { name: 'Deactivate' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Deactivate Spider?' });
    await user.click(within(confirm).getByRole('button', { name: 'Deactivate' }));
    expect(mockApi.put).toHaveBeenCalledTimes(1);
    expect(mockApi.put).toHaveBeenCalledWith('/api/ai-farm/spider/status', { isActive: false }, expect.anything());
    expect(await within(dialog).findByText('Not active', { selector: '[data-agent-chip]' })).toBeInTheDocument();
    expect(await within(dialog).findByRole('button', { name: 'Set up Spider' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Deactivate' })).toBeNull();
    // The status read again once the save settles.
    await waitFor(() => expect(mockApi.get.mock.calls.filter(([u]) => u === STATUS).length).toBeGreaterThanOrEqual(2));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("puts Active back with the server's sentence when Deactivate fails", async () => {
    signIn(SPIDER_COMPANY);
    spiderSwitch(ON);
    mockApi.put.mockRejectedValue(Object.assign(new Error('400'), {
      response: { status: 400, data: { error: 'Validation failed', details: [{ field: 'isActive', message: 'Spider could not be deactivated just now' }] } },
    }));
    const user = userEvent.setup();
    const dialog = openOn('spider');
    await user.click(await within(dialog).findByRole('button', { name: 'Deactivate' }));
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Deactivate Spider?' })).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Spider could not be deactivated just now'));
    expect(await within(dialog).findByText('Active', { selector: '[data-agent-chip]' })).toBeInTheDocument();
  });
});

describe('AgentDetailModal: the footer for an Admin', () => {
  function openRouted(agentId: string) {
    useAiCenterStore.getState().openModal(agentId);
    renderWithProviders(
      <Routes>
        <Route path="/" element={<AiCenterModal />} />
        <Route path="/spider" element={<div>Spider page</div>} />
      </Routes>,
    );
    return screen.getByRole('dialog', { name: AI_AGENTS.find((a) => a.id === agentId)!.name });
  }

  it.each([
    ['Active', ON, ['Close', 'Deactivate', 'Open Spider'], 'Open Spider'],
    ['Active, never set up', ON_NOT_SET_UP, ['Close', 'Deactivate', 'Open Spider'], 'Open Spider'],
    ['Not active', OFF, ['Close', 'Set up Spider'], 'Set up Spider'],
    ['Not active, never set up', NEVER_SET_UP, ['Close', 'Set up Spider'], 'Set up Spider'],
  ] as const)('while %s: %j, and "%s" opens the Spider page and changes nothing', async (_l, answer, buttons, way) => {
    signIn(SPIDER_COMPANY);
    spiderSwitch(answer);
    const user = userEvent.setup();
    const dialog = openRouted('spider');
    const open = await within(dialog).findByRole('button', { name: way });
    const footer = open.parentElement!;
    expect(within(footer).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(buttons);
    expect(open).not.toHaveAttribute('aria-disabled');
    expect(within(dialog).queryByRole('button', { name: /Activate$|Turn it on/ })).toBeNull();
    await user.click(open);
    expect(await screen.findByText('Spider page')).toBeInTheDocument();
    expect(useAiCenterStore.getState().open).toBe(false);
    expect(mockApi.put).not.toHaveBeenCalled();
  });
});

describe('AgentDetailModal: Works with', () => {
  it("lists the animals Spider's copy names and the ServWave modules it works in", () => {
    const dialog = openOn('spider');
    const section = within(dialog).getByRole('region', { name: 'Works with' });
    const agents = within(section).getByRole('list', { name: 'Agents' });
    const chips = within(agents).getAllByRole('button');
    ['Falcon', 'Dolphin', 'Woodpecker', 'Badger'].forEach((name, i) => expect(chips[i]).toHaveAccessibleName(name));
    expect(chips).toHaveLength(4);
    const modules = within(section).getByRole('list', { name: 'ServWave modules' });
    expect(within(modules).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Leads',
      'Phone',
      'Text messages',
    ]);
  });

  it('opens the named animal when its chip is clicked', () => {
    const dialog = openOn('spider');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Woodpecker' }));
    const next = screen.getByRole('dialog', { name: 'Woodpecker' });
    expect(within(next).getByText('Estimate follow-up')).toBeInTheDocument();
    expect(within(next).getByText('Book a call about Woodpecker')).toBeInTheDocument();
  });

  it('shows only modules for an agent whose copy names no other animal', () => {
    const dialog = openOn('mike');
    const section = within(dialog).getByRole('region', { name: 'Works with' });
    expect(within(section).queryByRole('list', { name: 'Agents' })).toBeNull();
    expect(within(section).getByText('Schedule')).toBeInTheDocument();
  });
});

describe('AgentDetailModal: deep link and booking', () => {
  it('a job tile deep link opens the right agent and then clears', () => {
    const dialog = openOn('iris');
    expect(within(dialog).getByText('Call note taker')).toBeInTheDocument();
    expect(useAiCenterStore.getState().focusAgentId).toBeNull();
  });

  it('Close returns to the catalog', () => {
    const dialog = openOn('mike');
    // Two ways out, the corner X and the footer's Close; the footer one is the text button.
    fireEvent.click(within(dialog).getByText('Close', { selector: 'button' }));
    expect(screen.queryByRole('dialog', { name: 'Border Collie' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'AI Agentic Farm' })).toBeInTheDocument();
  });

  it('Book a call hands over to the booking flow', () => {
    const dialog = openOn('mike');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Book a call about Border Collie' }));
    expect(screen.queryByRole('dialog', { name: 'Border Collie' })).toBeNull();
  });
});
