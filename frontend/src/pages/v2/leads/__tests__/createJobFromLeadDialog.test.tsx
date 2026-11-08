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
