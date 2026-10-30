import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { AI_AGENTS, AI_AGENT_COUNT, agentDisplayRole } from '@/lib/ai-center/agents';
import { LIVE_AGENTS, type LiveAgent } from '@/lib/ai-center/agentStatus';
import { AiJobAssistantBar } from '@/components/jobs/AiJobAssistantBar';
import { AiCenterModal } from './AiCenterModal';
import api from '@/lib/axios';
import { computeAccessibleName } from 'dom-accessibility-api';
import { useQuery } from '@tanstack/react-query';

const STATUS = '/api/ai-farm/spider/status';

function signIn(user: { org_is_demo: boolean; org_is_spider_pilot?: boolean; org_features?: string[]; role?: string; is_admin?: boolean }) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: any) => unknown) =>
    selector({ user: { id: 'u1', role: 'ADMIN', is_admin: true, ...user }, isAuthenticated: true }),
  );
}
const setDemoOrg = (isDemo: boolean) => signIn({ org_is_demo: isDemo });
/** A company that passes the Spider gate: the `spider` feature on a demo company. */
const setSpiderCompany = () => signIn({ org_is_demo: true, org_features: ['leads', 'spider'] });

// hidden: an open agent pop-up hides the catalog behind it from the accessibility tree.
const catalog = (): HTMLElement => screen.getAllByRole('dialog', { hidden: true })[0]!;
const cards = () =>
  Array.from(catalog().querySelectorAll<HTMLElement>('[data-agent-card]')).map((el) => el.dataset.agentCard);
const card = (id: string) => catalog().querySelector<HTMLElement>(`[data-agent-card="${id}"]`)!;

const spiderCalls = () => vi.mocked(api).get.mock.calls.filter(([url]) => String(url).includes('/spider/'));

/** What the Spider status route answers. */
function spiderStatus(answer: { isActive: boolean; isSetUp: boolean } | 'error' | 'never') {
  vi.mocked(api).get.mockImplementation((url: string) => {
    if (url !== STATUS) return Promise.resolve({ data: {} });
    if (answer === 'never') return new Promise(() => {});
    if (answer === 'error') return Promise.reject(Object.assign(new Error('x'), { response: { status: 500, data: {} } }));
    return Promise.resolve({ data: answer });
  });
}
const ON = { isActive: true, isSetUp: true };
const OFF = { isActive: false, isSetUp: true };
const NEVER_SET_UP = { isActive: false, isSetUp: false };
const ON_NOT_SET_UP = { isActive: true, isSetUp: false };

/** A card's status strip, and its words (null when it says nothing). */
const strip = (id: string) => card(id).querySelector<HTMLElement>('[data-agent-strip]')!;

beforeEach(() => {
  vi.mocked(api).get.mockReset();
  spiderStatus(OFF);
  // Simulate an explicit request to open the AI Agentic Farm (e.g. a stray entry point).
  useAiCenterStore.setState({ open: true, focusAgentId: null });
});

describe('AiCenterModal — available to all orgs', () => {
  it('renders the dialog for a real (non-demo) org', () => {
    setDemoOrg(false);
    renderWithProviders(<AiCenterModal />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders the dialog for a demo org', () => {
    setDemoOrg(true);
    renderWithProviders(<AiCenterModal />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // Only Spider is built, and only for a company that passes the Spider gate. For every other
  // company all 30 agents are discovery plus "book a call": every card and the header say so.
  it('shows every agent as Coming soon to a company without Spider, and asks nothing about Spider', async () => {
    setDemoOrg(false);
    renderWithProviders(<AiCenterModal />);
    for (const label of ['Available', 'Live', 'Active', 'On', 'Off']) expect(screen.queryAllByText(label)).toHaveLength(0);
    expect(screen.getAllByText('Coming soon')).toHaveLength(AI_AGENT_COUNT);
    for (const id of cards()) expect(strip(id!)).toHaveAttribute('data-agent-strip', 'coming_soon');
    expect(screen.getByText(`${AI_AGENT_COUNT} AI agents coming soon. Meet them, and book a call to be first in line.`)).toBeInTheDocument();
    // The phrase, not a bare 24/7: Falcon's own card legitimately says "works 24/7".
    expect(screen.queryByText(/agents working 24\/7/i)).toBeNull();
    // Ran, 14 Oct: no "in development" anywhere in the farm.
    expect(screen.queryByText(/in development/i)).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(spiderCalls()).toHaveLength(0);
  });

  it('counts only the agents that are not open to the company as coming soon', () => {
    setSpiderCompany();
    renderWithProviders(<AiCenterModal />);
    expect(screen.getByText(`${AI_AGENT_COUNT - 1} AI agents coming soon. Meet them, and book a call to be first in line.`)).toBeInTheDocument();
    // The catalog itself still lists every agent.
    expect(screen.getByRole('button', { name: new RegExp(`All agents\\s*${AI_AGENT_COUNT}`) })).toBeInTheDocument();
  });
});

// Ran, 14 Oct (controls design, card option B): a strip along the card's foot says where an agent
// stands. No switch on the card, and the strip is never a link: the whole card is one button.
describe('the card status strip', () => {
  it('reads "On, watching your leads" on a green strip while Spider is on', async () => {
    setSpiderCompany();
    spiderStatus(ON);
    renderWithProviders(<AiCenterModal />);
    expect(await within(strip('spider')).findByText('On, watching your leads')).toBeInTheDocument();
    expect(strip('spider')).toHaveAttribute('data-agent-strip', 'on');
    expect(strip('spider')).toHaveClass('bg-success-surface');
    expect(screen.getAllByText('Coming soon')).toHaveLength(AI_AGENT_COUNT - 1);
  });

  it('reads "Off" while Spider is off', async () => {
    setSpiderCompany();
    renderWithProviders(<AiCenterModal />);
    expect(await within(strip('spider')).findByText('Off')).toBeInTheDocument();
    expect(strip('spider')).not.toHaveClass('bg-success-surface');
  });

  // Ran, 14 Oct: the strip follows the switch. Off is "Off", set up or not.
  it.each([
    ['an Admin', 'ADMIN'],
    ['a Sales user', 'SALES'],
  ])('reads plain "Off" to %s while Spider is off and was never set up', async (_l, role) => {
    signIn({ org_is_demo: true, org_features: ['leads', 'spider'], role });
    spiderStatus(NEVER_SET_UP);
    renderWithProviders(<AiCenterModal />);
    expect(await within(strip('spider')).findByText('Off')).toBeInTheDocument();
    expect(strip('spider')).toHaveAttribute('data-agent-strip', 'off');
    expect(within(strip('spider')).queryByText(/set up/)).toBeNull();
  });

  it.each([
    ['an Admin', 'ADMIN'],
    ['a Sales user', 'SALES'],
  ])('reads "On, not set up yet" in amber to %s while Spider is on but was never set up', async (_l, role) => {
    signIn({ org_is_demo: true, org_features: ['leads', 'spider'], role });
    spiderStatus(ON_NOT_SET_UP);
    renderWithProviders(<AiCenterModal />);
    const words = await within(strip('spider')).findByText('On, not set up yet');
    expect(strip('spider')).toHaveAttribute('data-agent-strip', 'on');
    expect(strip('spider')).toHaveAttribute('data-agent-set-up', 'false');
    // Amber words, not the green strip of an agent that is working.
    expect(words.parentElement).toHaveClass('text-warning-text');
    expect(strip('spider')).not.toHaveClass('bg-success-surface');
    expect(within(strip('spider')).queryByText('On, watching your leads')).toBeNull();
  });

  it('holds the strip with a placeholder of the same height while the switch is read', async () => {
    setSpiderCompany();
    spiderStatus('never');
    renderWithProviders(<AiCenterModal />);
    const s = strip('spider');
    expect(s).toHaveAttribute('data-agent-strip', 'loading');
    expect(s.querySelector('[data-agent-strip-placeholder]')).not.toBeNull();
    expect(s).toHaveClass('min-h-[46px]');
    expect(s.textContent).toBe('');
  });

  it('says no status at all when the switch cannot be read', async () => {
    setSpiderCompany();
    spiderStatus('error');
    renderWithProviders(<AiCenterModal />);
    await waitFor(() => expect(strip('spider')).toHaveAttribute('data-agent-strip', 'unknown'));
    expect(strip('spider').textContent).toBe('');
  });

  it('holds no control: no link and no switch, on any card', async () => {
    setSpiderCompany();
    spiderStatus(ON);
    renderWithProviders(<AiCenterModal />);
    await within(strip('spider')).findByText('On, watching your leads');
    for (const id of cards()) {
      expect(card(id!).querySelector('a, [role="switch"], button button')).toBeNull();
    }
  });

  // A reader hears the card once, in order: "Spider, New, Lead manager, ..., Off".
  it('reads the name first, then the role, then the status, each once', async () => {
    setSpiderCompany();
    renderWithProviders(<AiCenterModal />);
    await within(strip('spider')).findByText('Off');
    const name = computeAccessibleName(card('spider'));
    expect(name.startsWith('Spider')).toBe(true);
    expect(name.match(/Spider/g)).toHaveLength(1);
    expect(name.match(/\bOff\b/g)).toHaveLength(1);
    expect(name.indexOf('Off')).toBeGreaterThan(name.indexOf('Lead manager'));
    const other = AI_AGENTS.find((a) => a.id !== 'spider')!;
    const otherName = computeAccessibleName(card(other.id));
    expect(otherName.startsWith(other.name)).toBe(true);
    expect(otherName.match(/Coming soon/g)).toHaveLength(1);
    expect(otherName.indexOf('Coming soon')).toBeGreaterThan(otherName.indexOf(agentDisplayRole(other.role)));
  });

  it('opening the catalog at a Spider company asks for the switch once, whatever the number of places that show it', async () => {
    setSpiderCompany();
    // The Spider card and the Spider pop-up both show the status.
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(<AiCenterModal />);
    const dialog = await screen.findByRole('dialog', { name: 'Spider' });
    expect(await within(dialog).findByText('Spider is off')).toBeInTheDocument();
    await within(strip('spider')).findByText('Off');
    expect(spiderCalls().map(([url]) => url)).toEqual([STATUS]);
  });
});

/** A fake registry entry for a second agent: no component may need an edit to show it. */
function fakeEntry(overrides: Partial<LiveAgent> = {}): LiveAgent {
  return {
    released: true,
    isAccessible: () => true,
    useSwitch: () => ({ data: { isActive: true, isSetUp: true }, isError: false }),
    useSetActive: () => ({ mutate: () => {}, isPending: false }),
    canManage: () => true,
    managePath: '/fake-agent',
    copy: {
      cardOn: 'On, herding your jobs',
      cardOnNotSetUp: 'On, no flock yet',
      onDetail: 'Herding your open jobs',
      offDetail: 'No jobs are being herded',
      onNotSetUpDetail: 'Pick the jobs to herd so it can start',
      offNotSetUpDetail: 'Turn it on, then pick the jobs to herd',
      notSetUpMemberDetail: 'An Admin has not set it up yet',
      memberOnNote: 'The fake agent is on for your company.',
      memberOnNotSetUpNote: 'The fake agent is on, waiting for its flock.',
      memberOffNote: 'An Admin turns the fake agent on or off.',
      turnOffWarning: ['The fake agent stops herding.'],
    },
    ...overrides,
  };
}

// SPEC-5: a real (non-demo) company on the server's Spider pilot list gets what a demo company gets.
describe('a company on the Spider pilot list', () => {
  // Admin is the flag on the person (P15), so a non-Admin pilot user carries is_admin: false.
  const signInPilot = (role = 'ADMIN', is_admin = true) =>
    signIn({ org_is_demo: false, org_is_spider_pilot: true, org_features: ['leads', 'spider'], role, is_admin });

  it('an Admin sees Spider Off on the card and the switch in its pop-up, never "Coming soon" or the booking call', async () => {
    signInPilot();
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(<AiCenterModal />);
    expect(await within(strip('spider')).findByText('Off')).toBeInTheDocument();
    const dialog = await screen.findByRole('dialog', { name: 'Spider' });
    expect(await within(dialog).findByRole('switch', { name: 'Switch Spider on or off' })).not.toBeChecked();
    expect(within(dialog).queryByText('Coming soon')).toBeNull();
    expect(within(dialog).queryByText('Book a call about Spider')).toBeNull();
    expect(within(card('spider')).queryByText('Coming soon')).toBeNull();
  });

  it('a Sales user sees the status and the staff note, and no switch', async () => {
    signInPilot('SALES', false);
    spiderStatus(ON);
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(<AiCenterModal />);
    expect(await within(strip('spider')).findByText('On, watching your leads')).toBeInTheDocument();
    const dialog = await screen.findByRole('dialog', { name: 'Spider' });
    expect(await within(dialog).findByText('Spider is on')).toBeInTheDocument();
    expect(within(dialog).getByText('Watching your open leads')).toBeInTheDocument();
    expect(within(dialog).queryByRole('switch')).toBeNull();
  });
});

// The registry asks for an agent's switch only for a company that can use the agent: it passes
// `enabled: accessible` to the switch hook. This fake hook does NOT check any gate of its own, so
// only the registry stands between a company without access and the request.
describe('a live agent the company cannot use', () => {
  const fake = AI_AGENTS.find((a) => a.id === 'mike')!;
  const fetchSwitch = vi.fn(async () => ({ isActive: true, isSetUp: true }));
  function useUngatedSwitch({ enabled }: { enabled: boolean }) {
    return useQuery({ queryKey: ['fake-agent-switch'], queryFn: fetchSwitch, enabled });
  }

  beforeEach(() => {
    fetchSwitch.mockClear();
    LIVE_AGENTS[fake.id] = fakeEntry({ released: false, isAccessible: () => false, useSwitch: useUngatedSwitch });
  });
  afterEach(() => {
    delete LIVE_AGENTS[fake.id];
  });

  it('never asks for its switch, on the card or in the pop-up, and shows Coming soon', async () => {
    setDemoOrg(false);
    useAiCenterStore.setState({ focusAgentId: fake.id });
    renderWithProviders(<AiCenterModal />);
    const dialog = await screen.findByRole('dialog', { name: fake.name });
    expect(within(dialog).getByText('Coming soon')).toBeInTheDocument();
    expect(within(dialog).getByText(`Book a call about ${fake.name}`)).toBeInTheDocument();
    expect(within(strip(fake.id)).getByText('Coming soon')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSwitch).not.toHaveBeenCalled();
  });
});

// Layer 1, the other "no": the agent is released to customers, but this company does not have it
// (plan, payment or anything else). One text for every agent, never naming a plan, and a booking
// call to turn it on. Still no request about its switch.
describe('a released agent the company does not have', () => {
  const fake = AI_AGENTS.find((a) => a.id === 'mike')!;
  const fetchSwitch = vi.fn(async () => ({ isActive: true, isSetUp: true }));
  function useUngatedSwitch({ enabled }: { enabled: boolean }) {
    return useQuery({ queryKey: ['fake-released-switch'], queryFn: fetchSwitch, enabled });
  }

  beforeEach(() => {
    fetchSwitch.mockClear();
    LIVE_AGENTS[fake.id] = fakeEntry({ released: true, isAccessible: () => false, useSwitch: useUngatedSwitch });
  });
  afterEach(() => {
    delete LIVE_AGENTS[fake.id];
  });

  it('says it is not on the account yet, on the card and in the pop-up, and books a call to turn it on', async () => {
    setDemoOrg(false);
    useAiCenterStore.setState({ focusAgentId: fake.id });
    const user = userEvent.setup();
    renderWithProviders(<AiCenterModal />);

    const dialog = await screen.findByRole('dialog', { name: fake.name });
    const row = dialog.querySelector<HTMLElement>('[data-agent-control-row]')!;
    expect(row).toHaveAttribute('data-agent-control-row', 'not_available');
    expect(within(row).getByText(`${fake.name} is not on your account yet`)).toBeInTheDocument();
    expect(within(row).getByText("Book a call and we'll turn it on for you.")).toBeInTheDocument();
    expect(within(dialog).queryByRole('switch')).toBeNull();
    expect(row.querySelector('[data-agent-chip]')).toBeNull();
    // Not "Coming soon", and nothing about plans or tiers.
    expect(within(dialog).queryByText('Coming soon')).toBeNull();
    expect(dialog.textContent).not.toMatch(/\b(plan|tier|upgrade|Scale|Pro)\b/i);
    expect(within(dialog).getByText('Close', { selector: 'button' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: new RegExp(`(Open|Set up) ${fake.name}`) })).toBeNull();

    const s = strip(fake.id);
    expect(s).toHaveAttribute('data-agent-strip', 'not_available');
    expect(within(s).getByText('Book a call to add it')).toBeInTheDocument();
    // Not counted as coming soon.
    expect(screen.getByText(`${AI_AGENT_COUNT - 1} AI agents coming soon. Meet them, and book a call to be first in line.`)).toBeInTheDocument();

    // The same booking flow as "Book a call about ...".
    await user.click(within(dialog).getByRole('button', { name: 'Book a call to turn it on' }));
    expect(screen.queryByRole('dialog', { name: fake.name })).toBeNull();
    expect(await screen.findByRole('dialog', { name: `Book a call about ${fake.name}` })).toBeInTheDocument();

    await new Promise((r) => setTimeout(r, 30));
    expect(fetchSwitch).not.toHaveBeenCalled();
  });

  it('turns into the usable agent, with its switch, once the company has it', async () => {
    LIVE_AGENTS[fake.id] = fakeEntry({ released: true });
    setDemoOrg(false);
    useAiCenterStore.setState({ focusAgentId: fake.id });
    renderWithProviders(<AiCenterModal />);
    const dialog = await screen.findByRole('dialog', { name: fake.name });
    expect(within(dialog).getByText(`${fake.name} is on`)).toBeInTheDocument();
    expect(within(dialog).getByRole('switch', { name: `Switch ${fake.name} on or off` })).toBeInTheDocument();
    expect(within(dialog).queryByText(/not on your account/)).toBeNull();
  });
});

// The next live agent is one registry entry. Nothing in a component names Spider, so a second
// entry must flip its card, its pop-up row, its switch and its footer on its own.
describe('a second live agent', () => {
  const fake = AI_AGENTS.find((a) => a.id === 'mike')!;
  const mutate = vi.fn();

  beforeEach(() => {
    mutate.mockClear();
    LIVE_AGENTS[fake.id] = fakeEntry({ useSetActive: () => ({ mutate, isPending: false }) });
  });
  afterEach(() => {
    delete LIVE_AGENTS[fake.id];
  });

  it('flips its card, the header count, its pop-up row, its switch and its footer', async () => {
    setDemoOrg(false);
    useAiCenterStore.setState({ focusAgentId: fake.id });
    const user = userEvent.setup();
    renderWithProviders(<AiCenterModal />);

    const dialog = await screen.findByRole('dialog', { name: fake.name });
    expect(within(dialog).getByText(`${fake.name} is on`)).toBeInTheDocument();
    expect(within(dialog).getByText('Herding your open jobs')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: `Open ${fake.name}` })).toBeInTheDocument();
    expect(within(dialog).queryByText(`Book a call about ${fake.name}`)).toBeNull();
    expect(within(dialog).queryByText('Coming soon')).toBeNull();

    // Its switch asks before turning it off, then calls its own write hook.
    await user.click(within(dialog).getByRole('switch', { name: `Switch ${fake.name} on or off` }));
    const confirm = await screen.findByRole('alertdialog', { name: `Turn off ${fake.name}?` });
    expect(within(confirm).getByText('The fake agent stops herding.')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Turn off' }));
    expect(mutate).toHaveBeenCalledWith(false);

    expect(within(strip(fake.id)).getByText('On, herding your jobs')).toBeInTheDocument();
    expect(screen.getByText(`${AI_AGENT_COUNT - 1} AI agents coming soon. Meet them, and book a call to be first in line.`)).toBeInTheDocument();
    // Spider is still closed to this company: no Spider request.
    expect(spiderCalls()).toHaveLength(0);
  });

  it('on before it is set up: its own words on the card and row, "Set up" open, and off with no question', async () => {
    LIVE_AGENTS[fake.id] = fakeEntry({
      useSwitch: () => ({ data: { isActive: true, isSetUp: false }, isError: false }),
      useSetActive: () => ({ mutate, isPending: false }),
    });
    setDemoOrg(false);
    useAiCenterStore.setState({ focusAgentId: fake.id });
    const user = userEvent.setup();
    renderWithProviders(<AiCenterModal />);

    const dialog = await screen.findByRole('dialog', { name: fake.name });
    expect(within(dialog).getByText(`${fake.name} is on`)).toBeInTheDocument();
    expect(within(dialog).getByText('Pick the jobs to herd so it can start')).toBeInTheDocument();
    const setUp = within(dialog).getByRole('button', { name: `Set up ${fake.name}` });
    expect(setUp).not.toHaveAttribute('aria-disabled');
    expect(within(strip(fake.id)).getByText('On, no flock yet')).toBeInTheDocument();

    // Nothing to lose: straight off, no question.
    await user.click(within(dialog).getByRole('switch', { name: `Switch ${fake.name} on or off` }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mutate).toHaveBeenCalledWith(false);
  });

  it('off and never set up: its own words, a working switch and a locked "Set up"', async () => {
    LIVE_AGENTS[fake.id] = fakeEntry({
      useSwitch: () => ({ data: { isActive: false, isSetUp: false }, isError: false }),
      useSetActive: () => ({ mutate, isPending: false }),
    });
    setDemoOrg(false);
    useAiCenterStore.setState({ focusAgentId: fake.id });
    const user = userEvent.setup();
    renderWithProviders(<AiCenterModal />);

    const dialog = await screen.findByRole('dialog', { name: fake.name });
    expect(within(dialog).getByText(`${fake.name} is off`)).toBeInTheDocument();
    expect(within(dialog).getByText('Turn it on, then pick the jobs to herd')).toBeInTheDocument();
    const locked = within(dialog).getByRole('button', { name: `Set up ${fake.name}` });
    expect(locked).toHaveAttribute('aria-disabled', 'true');
    expect(locked).toHaveAccessibleDescription(`${fake.name} is off. Turn it on to set it up.`);
    expect(within(strip(fake.id)).getByText('Off')).toBeInTheDocument();

    const sw = within(dialog).getByRole('switch', { name: `Switch ${fake.name} on or off` });
    expect(sw).not.toHaveAttribute('aria-disabled');
    await user.click(sw);
    expect(mutate).toHaveBeenCalledWith(true);
  });

  it('to someone who cannot manage it: its own words for on-but-not-set-up, and no switch', async () => {
    LIVE_AGENTS[fake.id] = fakeEntry({
      useSwitch: () => ({ data: { isActive: true, isSetUp: false }, isError: false }),
      canManage: () => false,
    });
    setDemoOrg(false);
    useAiCenterStore.setState({ focusAgentId: fake.id });
    renderWithProviders(<AiCenterModal />);

    const dialog = await screen.findByRole('dialog', { name: fake.name });
    expect(within(dialog).getByText(`${fake.name} is on`)).toBeInTheDocument();
    expect(within(dialog).getByText('An Admin has not set it up yet')).toBeInTheDocument();
    expect(within(dialog).getByText('The fake agent is on, waiting for its flock.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('switch')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: new RegExp(`(Open|Set up) ${fake.name}`) })).toBeNull();
  });
});

describe('AiCenterModal - the card', () => {
  it('shows the name, the role without "AI", and the blurb, with no "Learn more"', () => {
    setDemoOrg(false);
    renderWithProviders(<AiCenterModal />);
    const woodpecker = within(card('jordan'));
    expect(woodpecker.getByText('Woodpecker')).toBeInTheDocument();
    expect(woodpecker.getByText('Estimate follow-up')).toBeInTheDocument();
    expect(woodpecker.queryByText(/AI Estimate Follow-Up/)).toBeNull();
    expect(woodpecker.getByText(/chases every open quote/)).toBeInTheDocument();
    expect(screen.queryByText('Learn more')).toBeNull();
  });

  it('marks a new agent with a "New" tag', () => {
    setDemoOrg(false);
    renderWithProviders(<AiCenterModal />);
    expect(within(card('iris')).getByText('New')).toBeInTheDocument();
    expect(within(card('jordan')).queryByText('New')).toBeNull();
  });

  it('shows the route planner as the Chameleon (D9)', () => {
    setDemoOrg(false);
    renderWithProviders(<AiCenterModal />);
    expect(within(card('leo')).getByText('Chameleon')).toBeInTheDocument();
    expect(screen.queryByText(/Gecko/)).toBeNull();
  });

  it('the whole card is one button that opens the agent, by click or by keyboard', async () => {
    setDemoOrg(false);
    const user = userEvent.setup();
    renderWithProviders(<AiCenterModal />);
    expect(card('jordan').tagName).toBe('BUTTON');

    fireEvent.click(within(card('jordan')).getByText(/chases every open quote/));
    expect(await screen.findByText('Book a call about Woodpecker')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('Book a call about Woodpecker')).toBeNull();

    card('maya').focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Book a call about Falcon')).toBeInTheDocument();
  });

  it('the portraits go back to stills while the agent detail covers the grid', () => {
    setDemoOrg(false);
    // Every observed portrait reports itself on screen at once.
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private cb: IntersectionObserverCallback) {}
        observe(target: Element) {
          this.cb([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never);
        }
        disconnect() {}
        unobserve() {}
      },
    );
    renderWithProviders(<AiCenterModal />);
    const loopsInGrid = () => catalog().querySelectorAll('[data-agent-card] img[src$=".webp"]').length;
    expect(loopsInGrid()).toBe(AI_AGENT_COUNT - 1); // every animal; the Master Agent has no loop
    fireEvent.click(card('jordan'));
    expect(loopsInGrid()).toBe(0);
  });
});

describe('AiCenterModal - search and filter', () => {
  it('search narrows the grid by name or role, and says so when nothing matches', async () => {
    setDemoOrg(false);
    const user = userEvent.setup();
    renderWithProviders(<AiCenterModal />);
    const search = screen.getByRole('searchbox', { name: 'Search agents' });

    await user.type(search, 'wood');
    expect(cards()).toEqual(['jordan']);

    await user.clear(search);
    await user.type(search, 'collector');
    expect(cards()).toEqual(['marcus']);

    await user.clear(search);
    await user.type(search, 'zebra');
    expect(cards()).toEqual([]);
    expect(screen.getByText('No agents match “zebra”.')).toBeInTheDocument();
  });

  it('a category in the rail shows only that category', async () => {
    setDemoOrg(false);
    const user = userEvent.setup();
    renderWithProviders(<AiCenterModal />);
    const rail = screen.getByRole('navigation', { name: 'Categories' });

    await user.click(within(rail).getByRole('button', { name: /^Finance/ }));
    expect(cards()).toEqual(['ethan', 'marcus', 'joseph']);
    expect(within(rail).getByRole('button', { name: /^Finance/ })).toHaveAttribute('aria-current', 'true');

    await user.click(within(rail).getByRole('button', { name: /^All agents/ }));
    expect(cards()).toHaveLength(AI_AGENT_COUNT);
  });

  it('search and a category combine', async () => {
    setDemoOrg(false);
    const user = userEvent.setup();
    renderWithProviders(<AiCenterModal />);
    await user.click(screen.getByRole('button', { name: 'Marketing', pressed: false }));
    await user.type(screen.getByRole('searchbox', { name: 'Search agents' }), 'review');
    expect(cards()).toEqual(['chloe']);
  });
});

describe('AiCenterModal - deep links', () => {
  it('opening with a focus agent goes straight to that agent', () => {
    setDemoOrg(false);
    useAiCenterStore.setState({ focusAgentId: 'mike' });
    renderWithProviders(<AiCenterModal />);
    expect(screen.getByText('Book a call about Border Collie')).toBeInTheDocument();
    expect(screen.queryAllByText('Available')).toHaveLength(0);
  });

  it('a job page tile opens the catalog on the agent it names', async () => {
    setDemoOrg(false);
    useAiCenterStore.setState({ open: false, focusAgentId: null });
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <AiJobAssistantBar jobNumber="J00051" />
        <AiCenterModal />
      </>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Meet Hawk/ }));
    expect(await screen.findByText('Book a call about Hawk')).toBeInTheDocument();
  });
});
