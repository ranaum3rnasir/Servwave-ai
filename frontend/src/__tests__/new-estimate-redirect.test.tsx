/**
 * NewEstimateRedirect - `/estimates/new`, the create=edit shim. This page WRITES A DATABASE ROW as
 * a side effect of a route render, so the things worth pinning are the ones that decide whether it
 * writes, how many times, and what happens to the rest of the app afterwards:
 *
 *  - an anchorless visit creates nothing and bounces to the list (no doomed POST);
 *  - exactly ONE POST per mount, including under StrictMode's dev double-effect (the `startedRef`
 *    guard exists only for this - without it every dev create makes two drafts);
 *  - the anchor precedence lead_id -> customer_id -> job_id, one anchor per payload;
 *  - a failed create shows a real message and an escape hatch, never a hung spinner;
 *  - the estimate caches are invalidated, so the workspace we land on does not render its tab
 *    strip from a five-minute-stale list that predates the estimate we just created;
 *  - navigating away mid-flight is final - the create still lands server-side, but the user is not
 *    yanked forward into it (react-router's useNavigate keeps working after unmount: its
 *    `activeRef` is set in a layout effect with NO cleanup - react-router 7.18.0).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route, useNavigate } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import NewEstimateRedirect from '@/pages/NewEstimateRedirect';

const NEW_ID = 'e0000000-0000-0000-0000-0000000000aa';
const LEAD_ID = 'a0000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const JOB_ID = 'b0000000-0000-0000-0000-000000000001';
/** The key EstimateTabs reads its sibling list from - the cache the bug left stale. */
const TAB_STRIP_KEY = ['estimates', { lead_id: LEAD_ID }];

const CREATED = { data: { estimate: { id: NEW_ID } } };

/** A POST whose resolution the test controls, so "while the create is in flight" is observable. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The real route tree, trimmed to the destinations that matter. Everything is asserted through a
 * live router rather than a mocked `useNavigate`: the post-unmount navigate this page has to
 * defend against is only observable as an actual location change.
 */
function Harness() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate('/leads/lead-1')}>
        simulate back
      </button>
      <Routes>
        <Route path="/estimates/new" element={<NewEstimateRedirect />} />
        <Route path="/estimates" element={<div>estimates list</div>} />
        <Route path="/estimates/:id" element={<div>estimate workspace</div>} />
        <Route path="/leads/:id" element={<div>lead detail</div>} />
      </Routes>
    </>
  );
}

function renderAt(url: string, options?: { strict?: boolean }) {
  const tree = options?.strict ? (
    <StrictMode>
      <Harness />
    </StrictMode>
  ) : (
    <Harness />
  );
  return renderWithProviders(tree, { initialEntries: [url] });
}

describe('NewEstimateRedirect - anchorless visit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Armed on purpose: the assertion below has to fail because no request was WANTED, not
    // because an unconfigured mock happened to blow up.
    vi.mocked(api.post).mockResolvedValue(CREATED);
  });

  it('bounces to the estimates list without firing a create', async () => {
    renderAt('/estimates/new');

    expect(await screen.findByText('estimates list')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    // Never parked on the spinner. (The bounce is a render-time derivation, so an anchorless
    // visitor does not even get the one frame of it an effect-driven bounce would show - though
    // RTL flushes effects inside act(), so this assertion alone cannot tell the two apart.)
    expect(screen.queryByText('Creating estimate...')).not.toBeInTheDocument();
  });
});

describe('NewEstimateRedirect - the create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.post).mockResolvedValue(CREATED);
  });

  it('fires exactly ONE POST per mount under StrictMode', async () => {
    renderAt(`/estimates/new?lead_id=${LEAD_ID}`, { strict: true });

    expect(await screen.findByText('estimate workspace')).toBeInTheDocument();
    // StrictMode mounts, unmounts and remounts this page in dev; the useRef guard is the only
    // thing standing between that and a second orphan DRAFT on the lead.
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('anchors on lead_id and lands on the new estimate', async () => {
    renderAt(`/estimates/new?lead_id=${LEAD_ID}`);

    expect(await screen.findByText('estimate workspace')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/estimates', { lead_id: LEAD_ID });
  });

  it('anchors on customer_id when there is no lead_id', async () => {
    renderAt(`/estimates/new?customer_id=${CUSTOMER_ID}`);

    expect(await screen.findByText('estimate workspace')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/estimates', { customer_id: CUSTOMER_ID });
  });

  it('anchors on job_id when there is neither a lead_id nor a customer_id', async () => {
    renderAt(`/estimates/new?job_id=${JOB_ID}`);

    expect(await screen.findByText('estimate workspace')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/estimates', { job_id: JOB_ID });
  });

  it('sends ONE anchor in priority order lead -> customer -> job when several are present', async () => {
    renderAt(`/estimates/new?job_id=${JOB_ID}&customer_id=${CUSTOMER_ID}&lead_id=${LEAD_ID}`);

    expect(await screen.findByText('estimate workspace')).toBeInTheDocument();
    // The backend's singleAnchorGuard rejects a payload carrying more than one.
    expect(api.post).toHaveBeenCalledWith('/api/estimates', { lead_id: LEAD_ID });
  });
});

describe('NewEstimateRedirect - cache invalidation after the create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks the lead's cached estimate list stale so the workspace tab strip includes the new estimate", async () => {
    const post = deferred<typeof CREATED>();
    vi.mocked(api.post).mockReturnValue(post.promise);

    const { queryClient } = renderAt(`/estimates/new?lead_id=${LEAD_ID}`);

    // helpers' test client sets gcTime: 0, which would garbage-collect an observer-less query
    // before the assertion below can read it - the app's own client holds it for 5 minutes.
    queryClient.setQueryDefaults(['estimates'], { gcTime: Infinity });
    queryClient.setQueryData(TAB_STRIP_KEY, [{ id: 'pre-existing-sibling' }]);
    expect(queryClient.getQueryState(TAB_STRIP_KEY)?.isInvalidated).toBe(false);

    post.resolve(CREATED);

    // Wait for the redirect first: it proves the create actually settled, so "the cache is stale"
    // can't pass merely because nothing has happened yet.
    expect(await screen.findByText('estimate workspace')).toBeInTheDocument();
    expect(queryClient.getQueryState(TAB_STRIP_KEY)?.isInvalidated).toBe(true);
  });
});

describe('NewEstimateRedirect - failed create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the API error plus a way out instead of spinning forever', async () => {
    vi.mocked(api.post).mockRejectedValue({
      response: { data: { error: 'Cannot create estimate for a won lead' } },
    });

    renderAt(`/estimates/new?lead_id=${LEAD_ID}`);

    expect(await screen.findByText('Cannot create estimate for a won lead')).toBeInTheDocument();
    expect(screen.queryByText('Creating estimate...')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back to estimates' }));
    expect(await screen.findByText('estimates list')).toBeInTheDocument();
  });
});

describe('NewEstimateRedirect - navigating away mid-create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not yank the user forward into an estimate they walked away from', async () => {
    const post = deferred<typeof CREATED>();
    vi.mocked(api.post).mockReturnValue(post.promise);

    const { queryClient } = renderAt(`/estimates/new?lead_id=${LEAD_ID}`);
    expect(screen.getByText('Creating estimate...')).toBeInTheDocument();

    // Browser Back while the spinner is up.
    await userEvent.click(screen.getByRole('button', { name: 'simulate back' }));
    expect(screen.getByText('lead detail')).toBeInTheDocument();

    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    post.resolve(CREATED);

    // The row WAS created, so the lists still have to refresh - waiting on that is also what
    // proves the resolution handler ran, so the assertions below aren't just early.
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['estimates'] }));
    expect(screen.getByText('lead detail')).toBeInTheDocument();
    expect(screen.queryByText('estimate workspace')).not.toBeInTheDocument();
  });

  // The matching `setError` guard on the failure path is deliberately NOT pinned by a test: a
  // setState on an unmounted component is a silent no-op in React 18 (the old "can't perform a
  // React state update" warning is gone), so any such test would pass with or without the guard.
  // It stays in the component as hygiene, not because a test proves it.
});
