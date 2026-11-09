/* eslint-disable react-refresh/only-export-components -- a test harness, never hot-reloaded */
/**
 * The one harness for the routed Email page (`src/pages/v2/communication/InboxPage.tsx`) (#3259).
 *
 * Every test that mounts that page does it through `mountInbox` / `renderInbox`; none of them keeps a fake server of its own.
 * `serveInbox` answers the reads of the page's data hooks over the mocked client: the mailbox list, the mail, the held
 * messages, the groups, rules, team, the sending identity and the person's own mailbox. A test states only what differs. A
 * read a test needs to hold, fail or count is a ROUTE (`routes`), asked before the standard answers; `server.reads` lists
 * every read made. A test that stubs the page's data hooks instead of serving them takes the stubs from `inboxApiStub.ts`.
 */
import { vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { MemoryRouterProps } from 'react-router-dom';
import api from '@/lib/axios';
import type { AppAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import InboxPage from '@/pages/v2/communication/InboxPage';
import { renderWithProviders } from '../helpers';

type Params = Record<string, unknown>;
type Config = { params?: unknown } | undefined;

/** A read of the fake server: the first route whose `match` fits the URL answers. `raw` hands back the whole client response. */
export interface InboxRoute {
  match: (url: string) => boolean;
  /** The answer, or a function of the URL and the request's config asked on every read; it may throw or return a promise (a held or refused read). */
  // `{} | null` rather than `unknown`: a union with `unknown` is `unknown`, and the callback would lose its parameter types.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  data: {} | null | ((url: string, config?: { params?: unknown }) => unknown);
  raw?: boolean;
}

type Body<T> = T | ((params: Params) => T | Promise<T>);
type Answer = object | ((params: Params) => object | Promise<object>);

export interface InboxServer {
  /** The whole answer of `GET .../mailboxes`. */
  mailboxes?: Answer;
  /** The mail of `GET .../emails`: a list, or a function of the query that may return a promise (a held list). Default `[]`. */
  emails?: Body<unknown[]>;
  /** The whole answer of `GET .../emails/unmatched` (the held messages). */
  unmatched?: Answer;
  /** The whole answer of `GET .../sending-identity` and `GET .../my-mailbox`. Left out: `{}`. */
  sendingIdentity?: Answer;
  myMailbox?: Answer;
  /** `GET .../team-members`: the members. Default `[]`. */
  teamMembers?: unknown[];
  /** Asked before the standard answers. */
  routes?: InboxRoute[];
  /** What a read nothing above knows answers (the whole body), or a function asked on every such read. Default `{}`. */
  otherwise?: object | (() => object | Promise<object>);
}

const NOTHING: unknown[] = [];
const resolve = async <T,>(body: Body<T>, params: Params): Promise<T> => (typeof body === 'function' ? await (body as (p: Params) => T | Promise<T>)(params) : body);

/** The answer of `GET .../mailboxes` most tests give: the person's own box, the main box, nobody else; `over` changes fields. */
export const mailboxBody = (params: Params, over: Record<string, unknown> = {}) => ({
  scope: 'attached', selected: params.selected ?? 'mine', selected_label: null, selected_unread: 0, total_unread: 0,
  mine: { id: 'box-mine', unread: 0 }, held: [], main: { id: 'box-main', unread: 0 }, people: null, ...over,
});

/** Install the fake server on the mocked client. Returns the log of every read made. */
export function serveInbox(server: InboxServer = {}) {
  const reads: Array<{ url: string; params: Params }> = [];
  vi.mocked(api.get).mockImplementation((async (url: string, config?: Config) => {
    const params = (config?.params ?? {}) as Params;
    reads.push({ url, params });
    for (const r of server.routes ?? []) {
      if (!r.match(url)) continue;
      const out = typeof r.data === 'function' ? (r.data as (u: string, c?: Config) => unknown)(url, config) : r.data;
      const wrap = (v: unknown) => (r.raw ? v : { data: v });
      return out instanceof Promise ? out.then(wrap) : wrap(out);
    }
    if (url.endsWith('/communication/mailboxes') && server.mailboxes !== undefined) return { data: await resolve(server.mailboxes, params) };
    if (url === '/api/communication/emails/unmatched' && server.unmatched !== undefined) return { data: await resolve(server.unmatched, params) };
    if (url === '/api/communication/emails') return { data: { emails: await resolve(server.emails ?? NOTHING, params) } };
    if (url === '/api/communication/email-groups') return { data: { groups: [] } };
    if (url === '/api/communication/forward-rules') return { data: { rules: [] } };
    if (url === '/api/communication/team-members') return { data: { members: server.teamMembers ?? [] } };
    if (url === '/api/communication/sending-identity' && server.sendingIdentity !== undefined) return { data: await resolve(server.sendingIdentity, params) };
    if (url === '/api/communication/my-mailbox' && server.myMailbox !== undefined) return { data: await resolve(server.myMailbox, params) };
    return { data: (await (typeof server.otherwise === 'function' ? (server.otherwise as () => unknown)() : server.otherwise)) ?? {} };
  }) as typeof api.get);
  return { reads };
}

/** Sign in the dispatcher the tests of the page used to sign in by hand (id u1, role DISPATCHER, the email and phone features). */
export function signInDispatcher(): void {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u1', email: 'jane@test.com', first_name: 'Jane', last_name: 'Smith', role: 'DISPATCHER', organization_id: 'org-1', org_features: ['email', 'phone'] },
      isAuthenticated: true, isLoading: false, error: null,
    })) as typeof useAuthStore);
}

export interface RenderInbox {
  /** Who is signed in by ability. Left out: no provider. */
  ability?: AppAbility;
  entry?: NonNullable<MemoryRouterProps['initialEntries']>[number];
  /** Drawn next to the page in the same router (a location probe, for example). */
  beside?: ReactNode;
}

/** The page as an element, for a route table of a test's own. */
export const inboxElement = (): ReactElement => <InboxPage />;

/** Mount the page without touching the fake server. */
export function renderInbox(opts: RenderInbox = {}) {
  return renderWithProviders(opts.beside ? <><InboxPage />{opts.beside}</> : <InboxPage />, {
    ability: opts.ability,
    ...(opts.entry ? { initialEntries: [opts.entry] } : {}),
  });
}

/** Serve and mount the page. */
export function mountInbox(opts: InboxServer & RenderInbox = {}) {
  const server = serveInbox(opts);
  return { ...server, ...renderInbox(opts) };
}
