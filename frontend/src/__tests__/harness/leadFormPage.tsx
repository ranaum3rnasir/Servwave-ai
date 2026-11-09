/* eslint-disable react-refresh/only-export-components -- a test harness, never hot-reloaded */
/**
 * The one harness for the routed lead form (`src/pages/v2/leads/LeadFormPage.tsx`, new and edit) (#3259).
 *
 * Every test that mounts that page does it through `mountLeadForm` / `renderLeadForm` (or, in a route table beside other
 * pages, `leadFormElement()`); none of them keeps a fake server of its own. `serveLeadForm` answers the reads the form makes:
 * the creator rule's pre-fill, the people who can be assigned, the customer picker, the lead being edited and the
 * organization's lists. A read a test leaves out answers `{}`, as every fake server of these tests did; a test states only
 * what differs, and a read it needs to hold, fail or count is a ROUTE (`routes`), asked first. A test that mounts the form
 * beside other pages on one fake server passes the other pages' reads as `rest`.
 *
 * Tests that edit a lead on the lead detail page's fake server (`leadDetailPage.tsx`) keep that ONE server: that harness
 * answers `GET /api/leads/:id`, which is the form's read too.
 */
import { vi } from 'vitest';
import type { ReactElement } from 'react';
import type { MemoryRouterProps } from 'react-router-dom';
import api from '@/lib/axios';
import type { AppAbility } from '@/lib/ability';
import LeadFormPage from '@/pages/v2/leads/LeadFormPage';
import { renderWithProviders } from '../helpers';

type Config = { params?: unknown } | undefined;
type Params = Record<string, unknown>;

/** A read of the fake server: the first route whose `match` fits the URL answers with `data` (the whole body). */
export interface FormRoute {
  match: (url: string) => boolean;
  /** The answer, or a function of the URL asked on every read; it may throw or return a promise (a held or refused read). */
  // `{} | null` rather than `unknown`: a union with `unknown` is `unknown`, and the callback would lose its parameter types.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  data: {} | null | ((url: string, config?: { params?: unknown }) => unknown);
}

type Answer = object | ((params: Params) => object | Promise<object>);

export interface LeadFormServer {
  /** The whole body of `GET /api/leads/creator-prefill`. Left out: `{}`. */
  creatorPrefill?: Answer;
  /** The whole body of `GET /api/jobs/creator-prefill` (the new-job form, in a test that mounts both). */
  jobCreatorPrefill?: Answer;
  /** The body of `GET /api/users/assignable`: the people, or a function of the query (it may return a promise or throw). */
  assignable?: unknown[] | object | ((params: Params) => unknown);
  /** The customers `GET /api/customers/picker` offers, and the one `GET /api/customers/picker/:id` returns. */
  picker?: unknown[];
  pickerOne?: unknown;
  /** The lead being edited, as `GET /api/leads/:id` answers it. A function is asked on every read. */
  lead?: unknown | (() => unknown);
  /** The body of `GET /api/organization` (job types, sources, timezone). */
  organization?: object;
  /** Routes asked before the form's own, for a read this test needs to hold, fail or count. */
  routes?: FormRoute[];
  /** A server for the reads that are not the form's own, when the test mounts other pages too. Asked before `otherwise`. */
  rest?: (url: string, config?: { params?: unknown }) => unknown;
  /** What a read nothing above knows answers (the whole body). Default `{}`. */
  otherwise?: unknown;
}

const asked = async <T,>(v: T | ((p: Params) => T), params: Params): Promise<T> => (typeof v === 'function' ? (v as (p: Params) => T)(params) : v);

/** Install the fake server on the mocked client. */
export function serveLeadForm(server: LeadFormServer = {}): void {
  vi.mocked(api.get).mockImplementation((async (url: string, config?: Config) => {
    const params = (config?.params ?? {}) as Params;
    for (const r of server.routes ?? []) {
      if (!r.match(url)) continue;
      const out = typeof r.data === 'function' ? (r.data as (u: string, c?: Config) => unknown)(url, config) : r.data;
      return out instanceof Promise ? out.then((data) => ({ data })) : { data: out };
    }
    if (url === '/api/leads/creator-prefill' && server.creatorPrefill !== undefined) return { data: await asked(server.creatorPrefill, params) };
    if (url === '/api/jobs/creator-prefill' && server.jobCreatorPrefill !== undefined) return { data: await asked(server.jobCreatorPrefill, params) };
    if (url === '/api/users/assignable' && server.assignable !== undefined) return { data: await asked(server.assignable, params) };
    if (url === '/api/customers/picker' && server.picker !== undefined) return { data: { customers: server.picker } };
    if (/^\/api\/customers\/picker\/[^/]+$/.test(url) && server.pickerOne !== undefined) return { data: { customer: server.pickerOne } };
    if (/^\/api\/leads\/(?!creator-prefill)[^/]+$/.test(url) && server.lead !== undefined) return { data: { lead: typeof server.lead === 'function' ? (server.lead as () => unknown)() : server.lead } };
    if (url === '/api/organization' && server.organization !== undefined) return { data: server.organization };
    if (server.rest) return server.rest(url, config);
    return { data: server.otherwise ?? {} };
  }) as typeof api.get);
}

export interface RenderLeadForm {
  /** Who is signed in by ability. */
  ability?: AppAbility;
  entry?: NonNullable<MemoryRouterProps['initialEntries']>[number];
  /** Put the form in a route table of the test's own. */
  wrap?: (page: ReactElement) => ReactElement;
}

/** The form as an element, for a route table of a test's own beside other pages (one fake server, many pages). */
export const leadFormElement = (): ReactElement => <LeadFormPage />;

/** Mount the form without touching the fake server: for a test that serves (`serveLeadForm`, or the lead detail harness) and then mounts, or mounts more than once. */
export function renderLeadForm(opts: RenderLeadForm = {}) {
  const page = <LeadFormPage />;
  return renderWithProviders(opts.wrap ? opts.wrap(page) : page, {
    ability: opts.ability,
    ...(opts.entry ? { initialEntries: [opts.entry] } : {}),
  });
}

/** Serve the form's reads and mount it. */
export function mountLeadForm(opts: LeadFormServer & RenderLeadForm = {}) {
  serveLeadForm(opts);
  return renderLeadForm(opts);
}
