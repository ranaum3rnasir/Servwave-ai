/**
 * The convert-to-job dialog, as the ROUTED lead page mounts it.
 *
 * These cases were written against `components/leads/CreateJobFromLeadDialog`, whose only
 * caller was the unrouted `pages/LeadDetailPage`. That page is gone and so is the component;
 * the selection rules it encoded live on in `../components/createJobFromLeadDialog`, which had
 * no test of its own. The cases are unchanged - the v2 dialog seeds its selection from a lazy
 * initialiser on a body that only exists while the dialog is open, rather than from an effect
 * keyed on `open`, and the rule ("a valid preselect wins, else a lone convertible estimate,
 * else nothing") is the same rule.
 *
 * #2048 extended the dialog to multi-select: `onConvert` now takes an array of ids (a single
 * selection posts `['e1']`, not `'e1'`), several convertibles start all-checked, and a
 * `job_link`-attached estimate (the multi-convert path's ANCHOR pointer) is not convertible.
 */
import { vi, test, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CreateJobFromLeadDialog } from '../components/createJobFromLeadDialog';
import { CONVERT_DEPOSIT_BLOCKED_REASON } from '@/features/estimate-workspace/lib/convertToJob';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const base = {
  open: true,
  onOpenChange: vi.fn(),
  leadId: 'lead-1',
  canCreateEstimate: true,
  isConverting: false,
  onConvert: vi.fn(),
};

const approved = {
  id: 'e1',
  estimate_number: 'E00001',
  status: 'WON',
  total_amount: '1000',
  created_at: '2026-01-01',
  job: null,
};
const approved2 = {
  id: 'e4',
  estimate_number: 'E00004',
  status: 'WON',
  total_amount: '1200',
  created_at: '2026-01-04',
  job: null,
};
const sent = {
  id: 'e2',
  estimate_number: 'E00002',
  status: 'SENT',
  total_amount: '500',
  created_at: '2026-01-02',
  job: null,
};
const converted = {
  id: 'e3',
  estimate_number: 'E00003',
  status: 'WON',
  total_amount: '900',
  created_at: '2026-01-03',
  job: { id: 'job-7', job_number: 'J00007', status: 'UNSCHEDULED' },
};
// Attached only through the ANCHOR FK (the multi-convert path's own attach pointer) - PROVENANCE
// (`job`) stays null, so this row is not convertible even though `job` alone reads falsy.
const jobLinked = {
  id: 'e5',
  estimate_number: 'E00005',
  status: 'WON',
  total_amount: '700',
  created_at: '2026-01-05',
  job: null,
  job_id: 'job-9',
  job_link: { id: 'job-9', job_number: 'J00009', status: 'SCHEDULED' },
};

// #2188 slice 16 - WON and attached to nothing, so the dialog's own predicate calls it
// convertible, but its kind=DEPOSIT invoice is still pre-payment. POST /api/jobs refuses this
// estimate on BOTH branches, so offering it is a promise the API will not keep.
const depositBlocked = {
  id: 'e6',
  estimate_number: 'E00006',
  status: 'WON',
  total_amount: '800',
  created_at: '2026-01-06',
  job: null,
  job_id: null,
  invoices: [{ kind: 'DEPOSIT', status: 'SENT' }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// Case 1: no estimates → empty state message + Create job disabled
test('renders "No estimates yet" and Create job is disabled when estimates is empty', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[]} />);
  expect(screen.getByText(/no estimates yet/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /create job/i })).toBeDisabled();
});

// Case 2: single approved estimate auto-selected; Create job enabled; clicking calls onConvert
test('auto-selects the sole approved estimate and calls onConvert on click', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[approved]} />);
  const btn = screen.getByRole('button', { name: /create job/i });
  expect(btn).toBeEnabled();
  fireEvent.click(btn);
  expect(base.onConvert).toHaveBeenCalledWith(['e1']);
});

// Case 3: only SENT estimate → no approved message; Create job disabled
test('shows "No approved estimate to convert yet" and Create job is disabled for SENT-only', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[sent]} />);
  expect(screen.getByText(/no approved estimate to convert yet/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /create job/i })).toBeDisabled();
});

// Case 4: already-converted estimate shows job_number link; clicking it calls navigate + closes dialog
test('shows J00007 link and clicking it navigates to the job and closes dialog', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[converted]} />);
  const link = screen.getByRole('button', { name: /J00007/i });
  expect(link).toBeInTheDocument();
  fireEvent.click(link);
  expect(navigate).toHaveBeenCalledWith('/jobs/job-7');
  expect(base.onOpenChange).toHaveBeenCalledWith(false);
  // No convertible → Create job disabled
  expect(screen.getByRole('button', { name: /create job/i })).toBeDisabled();
});

// Case 5: preselectEstimateId picks the right estimate among multiple convertibles
test('preselectEstimateId selects the right estimate when multiple convertibles present', () => {
  render(
    <CreateJobFromLeadDialog
      {...base}
      estimates={[approved2, approved]}
      preselectEstimateId="e1"
    />
  );
  const btn = screen.getByRole('button', { name: /create job/i });
  expect(btn).toBeEnabled();
  fireEvent.click(btn);
  expect(base.onConvert).toHaveBeenCalledWith(['e1']);
});

// Case 6: canCreateEstimate=true → New estimate present; clicking it navigates + closes dialog
test('New estimate button navigates and closes dialog', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[]} canCreateEstimate={true} />);
  const newEstBtn = screen.getByRole('button', { name: /new estimate/i });
  expect(newEstBtn).toBeInTheDocument();
  fireEvent.click(newEstBtn);
  expect(navigate).toHaveBeenCalledWith('/estimates/new?lead_id=lead-1');
  expect(base.onOpenChange).toHaveBeenCalledWith(false);
});

// Case 7: canCreateEstimate=false → no "New estimate" control
test('no New estimate button when canCreateEstimate is false', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[]} canCreateEstimate={false} />);
  expect(screen.queryByRole('button', { name: /new estimate/i })).not.toBeInTheDocument();
});

// #2048 — multi-select cases

// Case 8: more than one convertible → all start checked, and confirming posts both ids in
// render (created_at) order.
test('all convertibles are checked by default when more than one is convertible, and confirming posts both ids in render order', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[approved2, approved]} />);
  const checkboxes = screen.getAllByRole('checkbox');
  expect(checkboxes).toHaveLength(2);
  checkboxes.forEach((box) => expect(box).toBeChecked());

  fireEvent.click(screen.getByRole('button', { name: /create job/i }));
  // estimates prop order is [approved2, approved] ("e4" then "e1") - the payload preserves it.
  expect(base.onConvert).toHaveBeenCalledWith(['e4', 'e1']);
});

// Case 9: a valid preselect selects ONLY that one, even with several convertibles present -
// checkbox-level assertion (case 5 above already covers the posted payload).
test('a valid preselect checks ONLY that estimate, leaving the other convertible unchecked', () => {
  render(
    <CreateJobFromLeadDialog {...base} estimates={[approved2, approved]} preselectEstimateId="e1" />
  );
  const e1Box = screen.getByRole('checkbox', { name: approved.estimate_number });
  const e4Box = screen.getByRole('checkbox', { name: approved2.estimate_number });
  expect(e1Box).toBeChecked();
  expect(e4Box).not.toBeChecked();
});

// Case 10: unchecking every row disables "Create job".
test('unchecking everything disables Create job', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[approved]} />);
  const box = screen.getByRole('checkbox', { name: approved.estimate_number });
  expect(box).toBeChecked();
  fireEvent.click(box);
  expect(screen.getByRole('button', { name: /create job/i })).toBeDisabled();
});

// Case 11: a job_link-attached estimate (multi-convert path's ANCHOR pointer) is not
// convertible, renders no checkbox, and names its job.
test('a job_link-attached estimate is not convertible and renders its job link', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[jobLinked]} />);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  const link = screen.getByRole('button', { name: /J00009/i });
  expect(link).toBeInTheDocument();
  fireEvent.click(link);
  expect(navigate).toHaveBeenCalledWith('/jobs/job-9');
  expect(screen.getByRole('button', { name: /create job/i })).toBeDisabled();
});

// Case 12 (R5 / H3.3) - the posted order is the RENDERED order, never toggle/click order.
// Unchecking the FIRST row then re-checking it must not move it to the end of the payload -
// a naive `[...selectedIds]` (a Set's insertion order) would, since re-adding a deleted
// member appends it. `estimates` prop order is [approved2 ("e4"), approved ("e1")].
test('unchecking then re-checking the first row keeps the posted order as rendered, not toggle order', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[approved2, approved]} />);
  const checkboxes = screen.getAllByRole('checkbox');
  expect(checkboxes).toHaveLength(2);

  // checkboxes[0] is "e4" (approved2, rendered first); uncheck then re-check it.
  fireEvent.click(checkboxes[0]!);
  expect(checkboxes[0]).not.toBeChecked();
  fireEvent.click(checkboxes[0]!);
  expect(checkboxes[0]).toBeChecked();

  fireEvent.click(screen.getByRole('button', { name: /create job/i }));
  expect(base.onConvert).toHaveBeenCalledWith(['e4', 'e1']);
});

// #2188 slice 16 - the deposit gate, which lives one level up from the convertibility predicate
// and which this dialog did not consult. The estimate itself is fine; the deposit is what holds
// it, and that is something the operator can go and fix - so the row is SHOWN and DISABLED with
// its reason, never silently dropped.
test('a deposit-blocked estimate is shown, offers no checkbox, and names the deposit as the reason', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[depositBlocked]} />);

  // Shown, not hidden.
  expect(screen.getByText('E00006')).toBeInTheDocument();
  // Not selectable.
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  // And it says why, in the one wording the estimate page already uses.
  expect(screen.getByText(CONVERT_DEPOSIT_BLOCKED_REASON)).toBeInTheDocument();
  // Nothing selectable => nothing to submit.
  expect(screen.getByRole('button', { name: /create job/i })).toBeDisabled();
  // ...but NOT the "approve an estimate first" guidance. This estimate IS approved; sending its
  // operator after an approval they already have would point them at the wrong thing. That
  // guidance stays keyed to the older, looser question it has always asked.
  expect(screen.queryByText(/no approved estimate to convert yet/i)).not.toBeInTheDocument();
});

// #2188 slice 16 - showing the blocked row disabled is not enough on its own. The selection is
// state on a body that stays mounted while the lead refetches, so an estimate that WAS selectable
// when the dialog opened can pick up a pre-payment deposit underneath a tick that is already set.
// The submit path re-asks the question instead of trusting the tick.
test('a selection that goes deposit-blocked while the dialog is open is dropped from the payload', () => {
  const { rerender } = render(
    <CreateJobFromLeadDialog {...base} estimates={[approved, approved2]} />
  );
  // Both start checked (two convertibles).
  expect(screen.getAllByRole('checkbox')).toHaveLength(2);

  // The lead refetches: E00004 now carries a deposit invoice that is still pre-payment.
  rerender(
    <CreateJobFromLeadDialog
      {...base}
      estimates={[approved, { ...approved2, invoices: [{ kind: 'DEPOSIT', status: 'DRAFT' }] }]}
    />
  );

  fireEvent.click(screen.getByRole('button', { name: /create job/i }));
  expect(base.onConvert).toHaveBeenCalledWith(['e1']);
});

// #2188 slice 16 - the property the whole slice exists for: the dialog's offer is a PROMISE.
// Every row it lets you tick is a row `POST /api/jobs` accepts; every row it refuses to let you
// tick is one the endpoint would refuse. The rules below are transcribed from that endpoint's
// multi-estimate branch (job.controller.ts create(), checks 3, 5 and 6) and stated here
// INDEPENDENTLY of convertToJob.ts, so a change to either mirror shows up as a disagreement
// rather than as two files drifting together. The endpoint's own half is pinned by
// backend/src/__tests__/job-multi-estimate.test.ts (WON / already-attached / unpaid deposit) and
// job-create-estimate-anchor.test.ts.
const API_DEPOSIT_OK = ['PAID', 'VOIDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

function apiWouldAccept(est: {
  status: string;
  job?: unknown;
  job_id?: string | null;
  invoices?: Array<{ kind: string; status: string }>;
}): boolean {
  // 3. All WON.
  if (est.status !== 'WON') return false;
  // 5. Unattached (anchor) AND unconverted (provenance). No idempotent return for multi.
  if (est.job_id != null || est.job != null) return false;
  // 6. A configured kind=DEPOSIT invoice must be past payment. No deposit invoice passes.
  const deposit = est.invoices?.find((inv) => inv.kind === 'DEPOSIT');
  return !deposit || API_DEPOSIT_OK.includes(deposit.status);
}

const dep = (status: string) => [{ kind: 'DEPOSIT', status }];

const MATRIX = [
  { estimate_number: 'M-NO-DEPOSIT', status: 'WON' },
  { estimate_number: 'M-DEP-PAID', status: 'WON', invoices: dep('PAID') },
  { estimate_number: 'M-DEP-VOIDED', status: 'WON', invoices: dep('VOIDED') },
  // The two POST-payment refund states. They settle the deposit, so they must NOT block - the
  // frontend list was short by exactly these two before slice 15 widened it.
  { estimate_number: 'M-DEP-PART-REFUNDED', status: 'WON', invoices: dep('PARTIALLY_REFUNDED') },
  { estimate_number: 'M-DEP-REFUNDED', status: 'WON', invoices: dep('REFUNDED') },
  // Pre-payment: the endpoint refuses all three.
  { estimate_number: 'M-DEP-DRAFT', status: 'WON', invoices: dep('DRAFT') },
  { estimate_number: 'M-DEP-SENT', status: 'WON', invoices: dep('SENT') },
  { estimate_number: 'M-DEP-PARTIAL', status: 'WON', invoices: dep('PARTIAL') },
  // A non-DEPOSIT invoice is not a deposit and gates nothing.
  { estimate_number: 'M-STANDARD-INV', status: 'WON', invoices: [{ kind: 'STANDARD', status: 'SENT' }] },
  { estimate_number: 'M-NOT-WON', status: 'SENT' },
  { estimate_number: 'M-DECLINED', status: 'DECLINED', invoices: dep('PAID') },
  {
    estimate_number: 'M-HAS-PROVENANCE-JOB',
    status: 'WON',
    job: { id: 'job-1', job_number: 'J00001', status: 'UNSCHEDULED' },
  },
  { estimate_number: 'M-ANCHORED', status: 'WON', job_id: 'job-2' },
  // Attached AND settled: still refused, on the attachment.
  { estimate_number: 'M-ANCHORED-DEP-PAID', status: 'WON', job_id: 'job-3', invoices: dep('PAID') },
].map((e, i) => ({
  id: `m${i}`,
  total_amount: '100',
  created_at: '2026-02-01',
  job: null,
  ...e,
}));

test('every estimate the dialog offers as selectable is one the API accepts, and vice versa', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={MATRIX} />);

  // Sanity: the matrix exercises both answers, so a predicate stuck on one is not "agreement".
  expect(MATRIX.filter(apiWouldAccept).length).toBeGreaterThan(0);
  expect(MATRIX.filter((e) => !apiWouldAccept(e)).length).toBeGreaterThan(0);

  for (const est of MATRIX) {
    // Every row is RENDERED - nothing is silently dropped, whatever the answer.
    expect(screen.getByText(est.estimate_number)).toBeInTheDocument();

    const offered = screen.queryByRole('checkbox', { name: est.estimate_number }) !== null;
    expect(
      offered,
      `${est.estimate_number}: dialog offers=${offered}, API accepts=${apiWouldAccept(est)}`
    ).toBe(apiWouldAccept(est));
  }

  // And the payload the footer would post is exactly the accepted set, in render order.
  fireEvent.click(screen.getByRole('button', { name: /create job/i }));
  expect(base.onConvert).toHaveBeenCalledWith(MATRIX.filter(apiWouldAccept).map((e) => e.id));
});

// A converter who only crewed the walkthrough: the lead answer leaves the estimate money out, so the rows carry no
// total_amount at all. The dialog draws no amount (not $NaN, not $0) and the estimate can still be converted.
test('draws no amount for an estimate whose total the server left out, and still converts it', () => {
  const { total_amount: _omitted, ...withoutTotal } = approved;
  const { container } = render(<CreateJobFromLeadDialog {...base} estimates={[withoutTotal]} />);
  expect(screen.getByText('E00001')).toBeInTheDocument();
  expect(container.ownerDocument.body.textContent).not.toMatch(/NaN|\$/);
  fireEvent.click(screen.getByRole('button', { name: /create job/i }));
  expect(base.onConvert).toHaveBeenCalledWith(['e1']);
});
