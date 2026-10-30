import { useMemo } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { isSpiderAdminUser, spiderAvailableFor } from '@/lib/spider/gate';
import { useSetSpiderActive, useSpiderStatus } from '@/lib/api/spider';

/**
 * The status every AI Agentic Farm agent shows, for the signed-in company. Three layers decide it,
 * for every agent (Ran, 13-14 Oct):
 *   1. Available: may this company use the agent at all?
 *        no, and it is not released to customers yet  -> "Coming soon" (every agent by default)
 *        no, but it is released (this company does not have it)  -> "Not on your account yet",
 *          one text for every agent and every reason, never naming a plan, so it can sell later
 *   2. On / off: the Admin's switch.                    -> "On" / "Off"
 *   3. Access: the agent's page opens only while it is on.
 * Beside the switch it carries whether the agent has been set up (it may be on before it is: an
 * Admin turns it on first, then sets it up). The footer's button is the way in, only while on.
 * Until the switch is read the answer is "loading", and when it cannot be read it is "unknown":
 * neither ever claims a state.
 *
 * The card, the detail pop-up (its control row AND its footer), the header count and the agent's
 * own page all read this, and no catalog component names an agent. LIVE_AGENTS is the only list of
 * built agents: making the next agent live is one entry here, with its own words.
 */
export type AgentDisplayStatus = 'coming_soon' | 'not_available' | 'on' | 'off' | 'loading' | 'unknown';

/**
 * The words for a released agent this company does not have (layer 1). The same for every agent
 * and every reason (plan, payment or anything else), so none of it names a plan or a tier.
 */
export const NOT_AVAILABLE_COPY = {
  /** The card's strip. */
  card: 'Book a call to add it',
  /** The pop-up row's first line. */
  title: (name: string) => `${name} is not on your account yet`,
  /** ...and its second. */
  detail: "Book a call and we'll turn it on for you.",
  /** The pop-up footer's booking button (the same booking flow as "Book a call about ..."). */
  book: 'Book a call to turn it on',
} as const;

/** The parts of the signed-in user the registry reads. */
export type AgentUser =
  | {
      role?: string;
      /** The Admin flag (P15). */
      is_admin?: boolean;
      org_features?: readonly string[];
      org_is_demo?: boolean;
      org_is_spider_pilot?: boolean;
    }
  | null
  | undefined;

/** What reading an agent's on/off switch returns (a react-query result fits it). */
export interface AgentSwitchResult {
  data: { isActive: boolean; isSetUp: boolean } | undefined;
  isError: boolean;
}

/**
 * What switching an agent on or off returns (a react-query mutation fits it). The hook moves the
 * switch at once, moves it back if the save fails and says so itself, so the pop-up only calls it.
 */
export interface AgentSetActiveResult {
  mutate: (isActive: boolean) => void;
  isPending: boolean;
}

/**
 * The words the generic card and pop-up need about one agent. Everything that names the agent's
 * own job lives here; the parts built from its name ("Spider is on", "Turn off Spider?") are put
 * together by the components from the catalog name.
 */
export interface AgentCopy {
  /** The card's strip while the agent is on and set up ("On, watching your leads"). */
  cardOn: string;
  /** ...while it is on but not set up yet ("On, not set up yet"). */
  cardOnNotSetUp: string;
  /** The pop-up row's second line while on and set up ("Watching your open leads"). */
  onDetail: string;
  /** ...while off and set up ("No new lead alerts are going out"). */
  offDetail: string;
  /** ...while on but not set up, to someone who may set it up: what is left to do. */
  onNotSetUpDetail: string;
  /** ...while off and never set up, to someone who may set it up: turn it on first. */
  offNotSetUpDetail: string;
  /** ...while not set up (on or off), to everyone else. */
  notSetUpMemberDetail: string;
  /** The pop-up footer note for someone who cannot manage it, while it is on and set up. */
  memberOnNote: string;
  /** ...while it is on but not set up yet. */
  memberOnNotSetUpNote: string;
  /** ...while it is off (set up or not). */
  memberOffNote: string;
  /** What turning it off does, one paragraph each, shown before it is turned off. */
  turnOffWarning: readonly string[];
}

export interface LiveAgent {
  /**
   * Whether the agent has been released to customers. Until it is, a company that cannot use it
   * sees "Coming soon"; once it is, such a company sees "Not on your account yet" and a booking
   * call to add it.
   */
  released: boolean;
  /** Layer 1: may this company use the agent? Checked before any request about it is made. */
  isAccessible: (user: AgentUser) => boolean;
  /**
   * Question 2: the agent's on/off switch. A hook. `enabled` is false for a company that cannot
   * use the agent (it must then ask nothing). Every place that shows the status shares one cached
   * read, so the whole catalog asks once.
   */
  useSwitch: (options: { enabled: boolean }) => AgentSwitchResult;
  /** Switching the agent on or off. A hook; it makes no request until it is called. */
  useSetActive: () => AgentSetActiveResult;
  /**
   * Who may switch the agent on or off and open its page (layers 2 and 3). Must match the server's
   * own guard on the agent's write routes, so nobody is shown a switch the server would refuse.
   * Today that is an Admin for every agent; everyone else reads the state in words. A later Roles &
   * Permissions "AI Farm" section will let Admins grant an agent to roles or users, and this check
   * (with the server's guard) is where that grant will be read.
   */
  canManage: (user: AgentUser) => boolean;
  /** The agent's own page, where it is set up. */
  managePath: string;
  copy: AgentCopy;
}

/** Every built agent, by catalog id. */
export const LIVE_AGENTS: Record<string, LiveAgent> = {
  spider: {
    // Not released: its launch is limited to demo companies and the pilot list (spiderAvailableFor),
    // so it has not gone to customers and every company outside the gate keeps seeing "Coming soon".
    // Releasing it is two steps: drop the demo/pilot half of the gate (in lib/spider/gate.ts and the server's
    // services/spider/gate.ts), and set this to true. A company without the feature then sees
    // "Not on your account yet".
    released: false,
    isAccessible: spiderAvailableFor,
    useSwitch: useSpiderStatus,
    useSetActive: useSetSpiderActive,
    // requireSpiderAdmin on the server: an Admin (who is never also on a custom role). The future
    // Roles & Permissions "AI Farm" grant is read here and in requireSpiderAdmin.
    canManage: isSpiderAdminUser,
    managePath: '/spider',
    copy: {
      cardOn: 'On, watching your leads',
      cardOnNotSetUp: 'On, not set up yet',
      onDetail: 'Watching your open leads',
      offDetail: 'No new lead alerts are going out',
      onNotSetUpDetail: 'Choose the statuses to watch so it can start',
      offNotSetUpDetail: 'Turn it on, then choose the statuses to watch',
      notSetUpMemberDetail: 'An Admin has not set it up yet',
      memberOnNote: 'Spider is on for your company. You get its alerts when you are on watch.',
      memberOnNotSetUpNote: 'Spider is on for your company. You will get its alerts once an Admin sets it up.',
      memberOffNote: 'An Admin turns Spider on or off. You will get its alerts once it is on.',
      turnOffWarning: [
        'Spider stops watching your leads and sends no new alerts. Any open Spider alerts are cleared for everyone, and Spider History keeps a record of them.',
        'Your statuses, time limits and who gets alerted are all kept. When you turn it back on, Spider sends one summary of the leads still past their time limit.',
      ],
    },
  },
};

export function agentAccessibleFor(agentId: string | null | undefined, user: AgentUser): boolean {
  const entry = agentId ? LIVE_AGENTS[agentId] : undefined;
  return entry?.isAccessible(user) ?? false;
}

/** The ids of every agent this company can use. */
export function accessibleAgentIdsFor(user: AgentUser): string[] {
  return Object.keys(LIVE_AGENTS).filter((id) => agentAccessibleFor(id, user));
}

/** Whether the agent has been released to customers (false for an agent that is not built). */
export function agentReleased(agentId: string | null | undefined): boolean {
  return (agentId ? LIVE_AGENTS[agentId]?.released : undefined) === true;
}

/**
 * The status shown, from the answers. `released` only matters to a company that cannot use the
 * agent. Set up or not never changes it: see agentIsSetUp.
 */
export function displayStatusFor(accessible: boolean, sw: AgentSwitchResult, released = false): AgentDisplayStatus {
  if (!accessible) return released ? 'not_available' : 'coming_soon';
  if (sw.data) return sw.data.isActive ? 'on' : 'off';
  return sw.isError ? 'unknown' : 'loading';
}

/** Whether the agent has been set up. Only an answer that was read says yes. */
export function agentIsSetUp(accessible: boolean, sw: AgentSwitchResult): boolean {
  return accessible && sw.data?.isSetUp === true;
}

export interface AgentStatus {
  /** On or off (or coming soon, loading, unknown): the switch alone. */
  status: AgentDisplayStatus;
  /**
   * Whether the agent has been set up, alongside the switch, so an agent that is on before it is
   * set up still reads as on. Only meaningful while the status is "on" or "off".
   */
  isSetUp: boolean;
  /** Whether this person may switch the agent and open its page (false unless it is available). */
  canManage: boolean;
  /** The agent's page, only for someone who may manage it. */
  managePath: string | undefined;
  /** The agent's own words, only for a company that can use it. */
  copy: AgentCopy | undefined;
}

const COMING_SOON: AgentStatus = {
  status: 'coming_soon',
  isSetUp: false,
  canManage: false,
  managePath: undefined,
  copy: undefined,
};

/**
 * An agent's status for the signed-in company. Reads the switch only for an agent this company can
 * use, so a company without access makes no request about it.
 *
 * Every registered agent's switch hook runs on every call, in registry order, with only the asked
 * agent's enabled: LIVE_AGENTS does not change while the app runs, so the hook order is stable
 * whichever agent a card or the pop-up is showing.
 */
export function useAgentStatus(agentId: string | null | undefined): AgentStatus {
  const user = useAuthStore((s) => s.user);
  let result = COMING_SOON;
  for (const [id, entry] of Object.entries(LIVE_AGENTS)) {
    const accessible = id === agentId && entry.isAccessible(user);
    const sw = entry.useSwitch({ enabled: accessible });
    if (id === agentId && !accessible && entry.released) {
      result = { ...COMING_SOON, status: 'not_available' };
    }
    if (accessible) {
      const canManage = entry.canManage(user);
      result = {
        status: displayStatusFor(true, sw),
        isSetUp: agentIsSetUp(true, sw),
        canManage,
        managePath: canManage ? entry.managePath : undefined,
        copy: entry.copy,
      };
    }
  }
  return result;
}

export interface AgentSwitchControl {
  /** Switch the agent on or off. Undefined unless this person may manage an agent this company has. */
  setActive: ((isActive: boolean) => void) | undefined;
  /** A save is on its way. */
  saving: boolean;
}

/**
 * The on/off control for one agent, for the pop-up. Same stable hook order as useAgentStatus: every
 * registered agent's write hook runs, and only the asked one is handed back, and only to someone
 * who may manage it at a company that can use it.
 */
export function useAgentSwitchControl(agentId: string | null | undefined): AgentSwitchControl {
  const user = useAuthStore((s) => s.user);
  let result: AgentSwitchControl = { setActive: undefined, saving: false };
  for (const [id, entry] of Object.entries(LIVE_AGENTS)) {
    const write = entry.useSetActive();
    if (id === agentId && entry.isAccessible(user) && entry.canManage(user)) {
      result = { setActive: write.mutate, saving: write.isPending };
    }
  }
  return result;
}

/** The ids of every agent the signed-in company can use. */
export function useAccessibleAgentIds(): string[] {
  const user = useAuthStore((s) => s.user);
  return useMemo(() => accessibleAgentIdsFor(user), [user]);
}
