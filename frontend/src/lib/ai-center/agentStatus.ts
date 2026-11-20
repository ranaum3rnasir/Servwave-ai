import { useMemo } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { isSpiderAdminUser, spiderAvailableFor } from '@/lib/spider/gate';
import { useSetSpiderActive, useSpiderStatus } from '@/lib/api/spider';
import { beeAllowedOrgIds } from '@/lib/useIsBeeAllowed';

/**
 * The status every AI Agentic Farm agent shows, for the signed-in company. Two facts decide it, for
 * every agent, each shown once (Ran 13-14 Oct; works like an integration, Ran 10 Nov):
 *   1. On the account: may this company use the agent at all?
 *        no, and it is not released to customers yet  -> "Coming soon" (every agent by default)
 *        no, but it is released (this company does not have it)  -> "Book a call to add it",
 *          one text for every agent and every reason, never naming a plan, so it can sell later
 *        yes  -> an "Available" tag beside the name (see agentOnAccount)
 *   2. Running: Not active / Active, read from the server. There is no switch: an agent is
 *      activated only on its own page, after its review; the pop-up can Deactivate it (with the
 *      same question as the page) and opens the page.
 * Until the status is read the answer is "loading", and when it cannot be read it is "unknown":
 * neither ever claims a state.
 *
 * The card, the detail pop-up (its status row AND its footer), the header count and the agent's
 * own page all read this, and no catalog component names an agent. LIVE_AGENTS is the only list of
 * built agents: making the next agent live is one entry here, with its own words.
 */
export type AgentDisplayStatus = 'coming_soon' | 'not_available' | 'active' | 'not_active' | 'loading' | 'unknown';

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

/** What reading whether an agent is Active returns (a react-query result fits it). */
export interface AgentActiveRead {
  data: { isActive: boolean } | undefined;
  isError: boolean;
}

/**
 * What deactivating an agent returns (a react-query mutation fits it). The hook shows the new state
 * at once, puts it back if the save fails and says so itself, so the pop-up only calls it.
 */
export interface AgentSetActiveResult {
  mutate: (isActive: boolean) => void;
  isPending: boolean;
}

/** The words the generic card and pop-up need about one agent, beyond its catalog name. */
export interface AgentCopy {
  /** The ? beside "Not active" in the pop-up, for someone who may manage the agent. */
  notActiveHelp: string;
  /**
   * What Deactivate does, one paragraph each, in the "Deactivate {name}?" question asked first, on
   * the agent's page (#3432) and in the pop-up (#3433): the same question in both places.
   */
  deactivateWarning: readonly string[];
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
   * Fact 2: whether the agent is Active. A hook. `enabled` is false for a company that cannot use
   * the agent (it must then ask nothing). Every place that shows the status shares one cached read,
   * so the whole catalog asks once.
   */
  useActive: (options: { enabled: boolean }) => AgentActiveRead;
  /**
   * Saving Active or Not active. A hook; it makes no request until it is called. The farm and the
   * agent's page only ever deactivate with it (see useAgentDeactivateControl): activating goes through
   * the page's own review.
   */
  useSetActive: () => AgentSetActiveResult;
  /**
   * Who may deactivate the agent and open its page. Must match the server's own guard on the
   * agent's write routes, so nobody is shown a button the server would refuse. Today that is an
   * Admin for every agent; everyone else reads the tag and the status. A later Roles & Permissions
   * "AI Farm" section will let Admins grant an agent to roles or users, and this check (with the
   * server's guard) is where that grant will be read.
   */
  canManage: (user: AgentUser) => boolean;
  /** The agent's own page, where it is set up. */
  managePath: string;
  copy: AgentCopy;
}

function isBeeAllowedUser(user: AgentUser): boolean {
  if (!user) return false;
  if (user.org_is_demo) return true;
  if (user.org_features && user.org_features.includes('bee')) return true;
  if ((user as any)?.feature_overrides?.bee === true) return true;
  const allowed = beeAllowedOrgIds();
  const orgId = (user as any)?.organization_id;
  if (orgId && allowed.includes(orgId.toLowerCase())) return true;
  return false;
}

const BEE_LIVE_AGENT: LiveAgent = {
  released: true,
  isAccessible: isBeeAllowedUser,
  useActive: () => ({ data: { isActive: true }, isError: false }),
  useSetActive: () => ({ mutate: () => {}, isPending: false }),
  canManage: () => true,
  managePath: '/bee',
  copy: {
    notActiveHelp: 'Bee is paused and makes no calls.',
    deactivateWarning: [
      'Bee will pause calling your customers for warranty and maintenance follow-ups.',
      'You can resume at any time from Bee settings.',
    ],
  },
};

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
    useActive: useSpiderStatus,
    useSetActive: useSetSpiderActive,
    // requireSpiderAdmin on the server: an Admin (who is never also on a custom role). The future
    // Roles & Permissions "AI Farm" grant is read here and in requireSpiderAdmin.
    canManage: isSpiderAdminUser,
    managePath: '/spider',
    copy: {
      // Mockup M1 "AI Agentic Farm card and pop-up" (Ran, 10 Nov), word for word.
      notActiveHelp: 'Spider watches nothing and sends nothing. Open it, check the settings, then press Activate.',
      // Mockup M1 "Activating and deactivating" (Ran, 10 Nov), word for word.
      deactivateWarning: [
        'Spider stops watching your leads and sends no new alerts. Any open Spider alerts are cleared for everyone, and Spider History keeps a record of them.',
        'Your statuses, time limits and who gets alerted are all kept. When you activate it again, the review asks whether to send one summary of the leads still past their time limit.',
      ],
    },
  },
  emily: BEE_LIVE_AGENT,
  bee: BEE_LIVE_AGENT,
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

/** The status shown, from the answers. `released` only matters to a company that cannot use the agent. */
export function displayStatusFor(accessible: boolean, read: AgentActiveRead, released = false): AgentDisplayStatus {
  if (!accessible) return released ? 'not_available' : 'coming_soon';
  if (read.data) return read.data.isActive ? 'active' : 'not_active';
  return read.isError ? 'unknown' : 'loading';
}

/**
 * Whether the agent is on this company's account, which the "Available" tag beside its name says.
 * True while its status is being read too: that it is on the account is known before.
 */
export function agentOnAccount(status: AgentDisplayStatus): boolean {
  return status !== 'coming_soon' && status !== 'not_available';
}

export interface AgentStatus {
  /** Active or Not active, or coming soon, not on the account, loading, unknown. */
  status: AgentDisplayStatus;
  /** Whether this person may deactivate the agent and open its page (false unless it is on the account). */
  canManage: boolean;
  /** The agent's page, only for someone who may manage it. */
  managePath: string | undefined;
  /** The agent's own words, only for a company that can use it. */
  copy: AgentCopy | undefined;
}

const COMING_SOON: AgentStatus = {
  status: 'coming_soon',
  canManage: false,
  managePath: undefined,
  copy: undefined,
};

/**
 * An agent's status for the signed-in company. Reads it only for an agent this company can use, so
 * a company without access makes no request about it.
 *
 * Every registered agent's read hook runs on every call, in registry order, with only the asked
 * agent's enabled: LIVE_AGENTS does not change while the app runs, so the hook order is stable
 * whichever agent a card or the pop-up is showing.
 */
export function useAgentStatus(agentId: string | null | undefined): AgentStatus {
  const user = useAuthStore((s) => s.user);
  let result = COMING_SOON;
  for (const [id, entry] of Object.entries(LIVE_AGENTS)) {
    const accessible = id === agentId && entry.isAccessible(user);
    const read = entry.useActive({ enabled: accessible });
    if (id === agentId && !accessible && entry.released) {
      result = { ...COMING_SOON, status: 'not_available' };
    }
    if (accessible) {
      const canManage = entry.canManage(user);
      result = {
        status: displayStatusFor(true, read),
        canManage,
        managePath: canManage ? entry.managePath : undefined,
        copy: entry.copy,
      };
    }
  }
  return result;
}

export interface AgentDeactivateControl {
  /**
   * Deactivate the agent. Only ever false: activating happens on the agent's page, after its review,
   * never from here. Undefined unless this person may manage an agent this company has.
   */
  setActive: ((isActive: false) => void) | undefined;
  /** A save is on its way. */
  saving: boolean;
}

/**
 * Deactivating one agent, for the pop-up and the agent's page. Same stable hook order as useAgentStatus: every
 * registered agent's write hook runs, and only the asked one is handed back, and only to someone
 * who may manage it at a company that can use it.
 */
export function useAgentDeactivateControl(agentId: string | null | undefined): AgentDeactivateControl {
  const user = useAuthStore((s) => s.user);
  let result: AgentDeactivateControl = { setActive: undefined, saving: false };
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
