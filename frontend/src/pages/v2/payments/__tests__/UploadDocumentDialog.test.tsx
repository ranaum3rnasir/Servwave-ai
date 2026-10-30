// Payments go-live v7 (V7-10b) - the Upload document dialog. The upload helper and the toast are mocked at their edge;
// the dialog's own decisions (validation, the search, the choice, what it sends, what it says) are real.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import type { DocumentTarget } from '@/lib/api/paymentsPage';
import { uploadAttachment } from '@/lib/attachments/uploadAttachment';
import { toast } from '@/ui-kit/components/ui/sonner';

import { UploadDocumentDialog } from '../components/UploadDocumentDialog';
import { mockApi } from './paymentsFixtures';

vi.mock('@/lib/attachments/uploadAttachment', () => ({ uploadAttachment: vi.fn() }));
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
const mockUpload = vi.mocked(uploadAttachment);
const mockToast = vi.mocked(toast);

const ABILITY = buildAbility([{ action: 'create', subject: 'Attachment' }]);

const INVOICES: DocumentTarget[] = [
  { id: 'inv-1', main: 'INV-1302 · Marcus Delgado', sub: null, amount: 642.5, due_date: '2026-10-20T12:00:00.000Z' },
  { id: 'inv-2', main: 'INV-1303 · Dana Whitfield', sub: null, amount: 80, due_date: null },
];
const JOBS: DocumentTarget[] = [{ id: 'job-1', main: 'J-4101 · Repair', sub: 'Marcus Delgado' }];
const CUSTOMERS: DocumentTarget[] = [{ id: 'cus-1', main: 'Dana Whitfield', sub: '(555) 123-4567' }];

let targetCalls: Array<{ kind: string; q: string }> = [];
function serve(over: Partial<Record<'invoice' | 'job' | 'customer', DocumentTarget[]>> = {}) {
  const all = { invoice: INVOICES, job: JOBS, customer: CUSTOMERS, ...over };
  targetCalls = [];
  mockApi.get.mockImplementation(((url: string, config?: { params?: { kind: 'invoice' | 'job' | 'customer'; q: string } }) => {
    if (url === '/api/organization') return Promise.resolve({ data: { timezone: 'America/Los_Angeles' } });
    if (url === '/api/payments-page/documents/targets') {
      const { kind, q } = config!.params!;
      targetCalls.push({ kind, q });
      const rows = all[kind].filter((t) => `${t.main} ${t.sub ?? ''}`.toLowerCase().includes(q.toLowerCase()));
      return Promise.resolve({ data: { targets: rows } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  }) as never);
}

const onOpenChange = vi.fn();
const onUploaded = vi.fn();
const pdf = (name = 'Signed scope of work.pdf') => new File(['x'], name, { type: 'application/pdf' });

function open(isOpen = true) {
  const ui = (o: boolean) => <UploadDocumentDialog open={o} onOpenChange={onOpenChange} onUploaded={onUploaded} />;
  const view = renderWithProviders(ui(isOpen), { ability: ABILITY });
  return { ...view, setOpen: (o: boolean) => view.rerender(ui(o)) };
}
const dialog = () => screen.getByRole('dialog', { name: 'Upload document' });
const fileInput = () => dialog().querySelector('input[type="file"]') as HTMLInputElement;
const list = () => within(dialog()).getByRole('radiogroup', { name: 'Attach to' });

beforeEach(() => {
  mockApi.get.mockReset();
  mockUpload.mockReset();
  mockUpload.mockResolvedValue(undefined);
  mockToast.success.mockReset();
  onOpenChange.mockReset();
  onUploaded.mockReset();
  serve();
});

describe('the form', () => {
  it('has File, Attach to (Invoice | Job | Customer, Invoice first), Find and the two buttons, and no sample-file control', async () => {
    open();
    await screen.findByText('INV-1302 · Marcus Delgado');
    const d = dialog();
    expect(within(d).getByText('File')).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Choose file' })).toBeInTheDocument();
    expect(within(d).getByText('No file chosen')).toBeInTheDocument();
    const attach = within(d).getByRole('group', { name: 'Attach to' });
    expect(within(attach).getAllByRole('button').map((b) => b.textContent)).toEqual(['Invoice', 'Job', 'Customer']);
    expect(within(attach).getByRole('button', { name: 'Invoice' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(d).getByLabelText('Find')).toHaveAttribute('type', 'search');
    expect(within(d).getByLabelText('Find')).toHaveAttribute('placeholder', 'Number or name');
    expect(within(d).getByRole('button', { name: 'Upload and attach' })).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByText(/sample file/i)).toBeNull();
  });

  it('lists invoices with the amount and due day under the number and customer', async () => {
    open();
    const row = (await screen.findByText('INV-1302 · Marcus Delgado')).closest('[role="radio"]')!;
    expect(row).toHaveTextContent('$642.50, due Oct 20');
    expect(screen.getByText('INV-1303 · Dana Whitfield').closest('[role="radio"]')).toHaveTextContent('$80.00');
    expect(targetCalls[0]).toEqual({ kind: 'invoice', q: '' });
  });

  it('shows the file name once chosen', async () => {
    const u = userEvent.setup();
    open();
    await u.upload(fileInput(), pdf());
    expect(within(dialog()).getByText('Signed scope of work.pdf')).toBeInTheDocument();
  });

  it('refuses a type the server would refuse, with the module sentence, and keeps no file', async () => {
    const u = userEvent.setup({ applyAccept: false });
    open();
    await u.upload(fileInput(), new File(['x'], 'tool.exe', { type: 'application/x-msdownload' }));
    expect(await within(dialog()).findByText(/"tool.exe" can't be attached\. Use a photo/)).toBeInTheDocument();
    expect(within(dialog()).getByText('No file chosen')).toBeInTheDocument();
  });

  it('refuses a file over the size cap with the module sentence', async () => {
    const u = userEvent.setup();
    open();
    const big = pdf('big.pdf');
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 });
    await u.upload(fileInput(), big);
    expect(await within(dialog()).findByText(/"big\.pdf" is 26MB — over the 25MB limit/)).toBeInTheDocument();
  });
});

describe('validation', () => {
  it('asks for a file first, then for a record, and sends nothing while either is missing', async () => {
    const u = userEvent.setup();
    open();
    await screen.findByText('INV-1302 · Marcus Delgado');
    await u.click(within(dialog()).getByRole('button', { name: 'Upload and attach' }));
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('Choose a file first.');
    await u.upload(fileInput(), pdf());
    await u.click(within(dialog()).getByRole('button', { name: 'Upload and attach' }));
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('Choose what to attach it to.');
    expect(mockUpload).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('where the errors appear', () => {
  it('renders the error before the list and moves focus to it, so a phone sees it', async () => {
    const u = userEvent.setup();
    open();
    await screen.findByText('INV-1302 · Marcus Delgado');
    await u.click(within(dialog()).getByRole('button', { name: 'Upload and attach' }));
    const alert = within(dialog()).getByRole('alert');
    expect(alert).toHaveTextContent('Choose a file first.');
    expect(alert).toHaveFocus();
    expect(alert.compareDocumentPosition(list()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a search error with Retry instead of "Nothing matches" when the search fails', async () => {
    const u = userEvent.setup();
    mockApi.get.mockImplementation(((url: string) => {
      if (url === '/api/organization') return Promise.resolve({ data: { timezone: 'America/Los_Angeles' } });
      return Promise.reject(new Error('Network Error'));
    }) as never);
    open();
    expect(await within(dialog()).findByText('Couldn’t search.')).toBeInTheDocument();
    expect(within(dialog()).queryByText('Nothing matches')).not.toBeInTheDocument();
    serve();
    await u.click(within(dialog()).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('INV-1302 · Marcus Delgado')).toBeInTheDocument();
  });
});

describe('the Attach to choice and the search', () => {
  it('searches on the server (debounced) with the kind and the text', async () => {
    const u = userEvent.setup();
    open();
    await screen.findByText('INV-1302 · Marcus Delgado');
    await u.type(within(dialog()).getByLabelText('Find'), 'dana');
    await waitFor(() => expect(targetCalls.at(-1)).toEqual({ kind: 'invoice', q: 'dana' }));
    // one call for the whole word, not one per letter
    expect(targetCalls.filter((c) => c.q !== '' && c.q !== 'dana')).toHaveLength(0);
    expect(await screen.findByText('INV-1303 · Dana Whitfield')).toBeInTheDocument();
    expect(screen.queryByText('INV-1302 · Marcus Delgado')).not.toBeInTheDocument();
  });

  it('says "Nothing matches" for an empty result', async () => {
    const u = userEvent.setup();
    open();
    await screen.findByText('INV-1302 · Marcus Delgado');
    await u.type(within(dialog()).getByLabelText('Find'), 'zzz');
    expect(await within(dialog()).findByText('Nothing matches')).toBeInTheDocument();
  });

  it('clears the pick and the search text and re-lists when the kind changes', async () => {
    const u = userEvent.setup();
    open();
    await u.click(await screen.findByRole('radio', { name: /INV-1302/ }));
    expect(screen.getByRole('radio', { name: /INV-1302/ })).toHaveAttribute('aria-checked', 'true');
    await u.type(within(dialog()).getByLabelText('Find'), 'mar');
    await u.click(within(dialog()).getByRole('button', { name: 'Job' }));
    expect(within(dialog()).getByLabelText('Find')).toHaveValue('');
    expect(await screen.findByText('J-4101 · Repair')).toBeInTheDocument();
    expect(screen.getByText('Marcus Delgado')).toBeInTheDocument();
    expect(targetCalls.at(-1)).toEqual({ kind: 'job', q: '' });
    expect(within(list()).queryByRole('radio', { checked: true })).toBeNull();
    await u.click(within(dialog()).getByRole('button', { name: 'Customer' }));
    expect(await screen.findByText('(555) 123-4567')).toBeInTheDocument();
  });

  it('moves the choice with the arrow keys and Enter in Find does not press Upload and attach', async () => {
    const u = userEvent.setup();
    open();
    const first = await screen.findByRole('radio', { name: /INV-1302/ });
    first.focus();
    await u.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: /INV-1303/ })).toHaveAttribute('aria-checked', 'true');
    await u.type(within(dialog()).getByLabelText('Find'), '{Enter}');
    expect(mockUpload).not.toHaveBeenCalled();
    expect(within(dialog()).queryByRole('alert')).toBeNull();
  });
});

describe('uploading', () => {
  it.each([
    ['invoice', /INV-1302/, 'inv-1', 'invoice INV-1302'],
    ['job', /J-4101/, 'job-1', 'job J-4101'],
    ['customer', /Dana Whitfield/, 'cus-1', 'customer Dana Whitfield'],
  ] as const)('sends the file to the %s with the Documents marker, closes, toasts the exact sentence and refreshes the list', async (kind, pick, id, said) => {
    const u = userEvent.setup();
    open();
    await screen.findByText('INV-1302 · Marcus Delgado');
    await u.click(within(dialog()).getByRole('button', { name: kind[0]!.toUpperCase() + kind.slice(1) }));
    await u.upload(fileInput(), pdf());
    await u.click(await screen.findByRole('radio', { name: pick }));
    await u.click(within(dialog()).getByRole('button', { name: 'Upload and attach' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const args = mockUpload.mock.calls[0]![0];
    expect(args).toMatchObject({ entityType: kind, entityId: id, source: 'PAYMENTS_DOCUMENTS' });
    expect(args.file.name).toBe('Signed scope of work.pdf');
    expect(args.displayName).toBeUndefined(); // the helper's default: the name without its extension
    expect(mockToast.success).toHaveBeenCalledWith(`Uploaded Signed scope of work.pdf and attached it to ${said}`);
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open and shows the server sentence when the upload is refused', async () => {
    const u = userEvent.setup();
    mockUpload.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 403, data: { error: 'You do not have access to this record' } } }));
    open();
    await u.upload(fileInput(), pdf());
    await u.click(await screen.findByRole('radio', { name: /INV-1302/ }));
    await u.click(within(dialog()).getByRole('button', { name: 'Upload and attach' }));
    expect(await within(dialog()).findByText('You do not have access to this record')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('shows progress on the button and holds Cancel while the file is on its way', async () => {
    const u = userEvent.setup();
    let finish: () => void = () => undefined;
    mockUpload.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    open();
    await u.upload(fileInput(), pdf());
    await u.click(await screen.findByRole('radio', { name: /INV-1302/ }));
    await u.click(within(dialog()).getByRole('button', { name: 'Upload and attach' }));
    expect(within(dialog()).getByRole('button', { name: 'Upload and attach' })).toBeDisabled();
    expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await u.click(within(dialog()).getByRole('button', { name: 'Upload and attach' }));
    expect(mockUpload).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe('opening again', () => {
  it('starts empty on every open: no file, no choice, no search text, no error', async () => {
    const u = userEvent.setup();
    const { setOpen } = open();
    await u.upload(fileInput(), pdf());
    await u.click(await screen.findByRole('radio', { name: /INV-1302/ }));
    await u.type(within(dialog()).getByLabelText('Find'), 'mar');
    await u.click(within(dialog()).getByRole('button', { name: 'Customer' }));
    await u.click(within(dialog()).getByRole('button', { name: 'Upload and attach' }));
    setOpen(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    setOpen(true);
    const d = await screen.findByRole('dialog', { name: 'Upload document' });
    expect(within(d).getByText('No file chosen')).toBeInTheDocument();
    expect(within(d).getByLabelText('Find')).toHaveValue('');
    expect(within(d).getByRole('button', { name: 'Invoice' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(d).queryByRole('alert')).toBeNull();
  });
});

describe('copy', () => {
  it('names no payment processor in the dialog', async () => {
    open();
    await screen.findByText('INV-1302 · Marcus Delgado');
    expect(dialog().textContent).not.toMatch(/stripe|acct_/i);
  });
});
