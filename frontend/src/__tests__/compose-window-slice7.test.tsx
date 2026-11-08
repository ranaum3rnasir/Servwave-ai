// Email slice 7 (Resend send path, ComposeWindow rewrite):
//   - Cc/Bcc collapses behind a toggle and wires into ComposeState.
//   - filesToAttachments keeps the real File object through to send time
//     (the bug this slice fixes - it used to discard it).
//   - useUndoSend defers a queued send behind a cancellable window.
//   - ComposerToolbar's "Insert template" popover reads the same
//     text_templates data the SMS composer uses.
//   - useSendEmail posts multipart/form-data with a `files` field.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import {
  ComposeWindow,
  ComposerToolbar,
  AttachFromRecord,
  filesToAttachments,
  useUndoSend,
} from '@/components/communication/inbox/ComposeWindow';
import { useSendEmail } from '@/lib/api/communication';
import type { ComposeState } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

const COMPOSE: ComposeState = {
  mode: 'new',
  account: 'system',
  to: '',
  subject: '',
  body: '',
};

function noop() {}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no templates, no attach-source hits - most tests here don't
  // exercise either and just need api.get to resolve to something.
  mockApi.get.mockResolvedValue({ data: {} });
});

// ─── filesToAttachments — real File retention ──────────────────────────────

describe('filesToAttachments — real File retention (email slice 7)', () => {
  it('keeps the actual File object on each attachment, not just display strings', () => {
    const file = new File(['hello'], 'photo.png', { type: 'image/png' });
    const list = {
      0: file,
      length: 1,
      item: (i: number) => (i === 0 ? file : null),
      [Symbol.iterator]: function* () {
        yield file;
      },
    } as unknown as FileList;

    const [attachment] = filesToAttachments(list);

    expect(attachment?.file).toBe(file);
    expect(attachment?.name).toBe('photo.png');
    expect(attachment?.mimeType).toBe('image/png');
    expect(attachment?.sizeBytes).toBe(file.size);
  });

  it('returns [] for a null FileList (nothing picked)', () => {
    expect(filesToAttachments(null)).toEqual([]);
  });
});

// ─── ComposeWindow — Cc/Bcc ─────────────────────────────────────────────────

describe('ComposeWindow — Cc/Bcc', () => {
  it('is collapsed by default, behind a toggle next to To', () => {
    renderWithProviders(
      <ComposeWindow state={COMPOSE} onChange={noop} onSend={noop} onClose={noop} onDiscard={noop} onToast={noop} />,
    );

    expect(screen.queryByPlaceholderText('Cc')).toBeNull();
    expect(screen.queryByPlaceholderText('Bcc')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cc/Bcc' })).toBeInTheDocument();
  });

  it('expands into Cc/Bcc inputs when the toggle is clicked, and wires typed values into ComposeState', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();
    renderWithProviders(
      <ComposeWindow state={COMPOSE} onChange={onChange} onSend={noop} onClose={noop} onDiscard={noop} onToast={noop} />,
    );

    await user.click(screen.getByRole('button', { name: 'Cc/Bcc' }));
    const cc = screen.getByPlaceholderText('Cc');
    const bcc = screen.getByPlaceholderText('Bcc');
    expect(cc).toBeInTheDocument();
    expect(bcc).toBeInTheDocument();
    // The toggle itself disappears once open - there is nothing left to expand.
    expect(screen.queryByRole('button', { name: 'Cc/Bcc' })).toBeNull();

    fireEvent.change(cc, { target: { value: 'ops@example.com' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ cc: 'ops@example.com' }));

    fireEvent.change(bcc, { target: { value: 'audit@example.com' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ bcc: 'audit@example.com' }));
  });

  it('starts already expanded when the draft carries cc/bcc (e.g. restored from Undo)', () => {
    renderWithProviders(
      <ComposeWindow
        state={{ ...COMPOSE, cc: 'a@x.com', bcc: 'b@x.com' }}
        onChange={noop}
        onSend={noop}
        onClose={noop}
        onDiscard={noop}
        onToast={noop}
      />,
    );

    expect(screen.getByDisplayValue('a@x.com')).toBeInTheDocument();
    expect(screen.getByDisplayValue('b@x.com')).toBeInTheDocument();
  });
});

// ─── AttachFromRecord — conditional on attach-by-origin context ────────────

describe('AttachFromRecord — conditional rendering', () => {
  it('renders nothing for a free compose with no job/customer/estimate/invoice id', () => {
    const { container } = renderWithProviders(
      <AttachFromRecord origin={{}} attachments={[]} onAttach={noop} onToast={noop} />,
    );
    expect(container.textContent).toBe('');
  });

  it('renders one-click chips for an anchored draft\'s existing uploads', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/communication/emails/attach-source') {
        return Promise.resolve({
          data: {
            attachments: [
              {
                id: 'att-1',
                file_name: 'before.jpg',
                file_url: 'https://storage.example/before.jpg',
                file_type: 'image/jpeg',
                file_size: 1024,
                display_name: 'Before photo',
                created_at: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderWithProviders(
      <AttachFromRecord origin={{ jobId: 'job-1' }} attachments={[]} onAttach={noop} onToast={noop} />,
    );

    expect(await screen.findByText('Before photo')).toBeInTheDocument();
    expect(screen.getByText('Attach from this record')).toBeInTheDocument();
  });
});

// ─── ComposerToolbar — Insert template ──────────────────────────────────────

describe('ComposerToolbar — Insert template (email slice 7)', () => {
  const TEMPLATES = [
    {
      id: 't1',
      name: 'Follow-up',
      info: 'Sent after a visit',
      body: 'Thanks for having us out!',
      defaultBody: 'Thanks for having us out!',
      fields: [],
      audience: 'customer',
      kind: 'custom',
    },
  ];

  it('lists the org\'s text templates and inserts the chosen body via onInsertTemplate', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/communication/templates') {
        return Promise.resolve({ data: { templates: TEMPLATES } });
      }
      return Promise.resolve({ data: {} });
    });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onInsertTemplate = vi.fn();
    renderWithProviders(
      <ComposerToolbar onAddFiles={noop} onInsert={noop} onInsertTemplate={onInsertTemplate} onToast={noop} />,
    );

    await user.click(screen.getByRole('button', { name: 'Insert template' }));
    await user.click(await screen.findByText('Follow-up'));

    expect(onInsertTemplate).toHaveBeenCalledWith('Thanks for having us out!');
  });

  it('shows an empty state instead of a blank popover when the org has no templates', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <ComposerToolbar onAddFiles={noop} onInsert={noop} onInsertTemplate={noop} onToast={noop} />,
    );

    await user.click(screen.getByRole('button', { name: 'Insert template' }));
    expect(await screen.findByText('No templates yet')).toBeInTheDocument();
  });

  it('no longer accepts (or needs) an attachDisabled prop - Attach files always opens the picker', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onAddFiles = vi.fn();
    renderWithProviders(
      <ComposerToolbar onAddFiles={onAddFiles} onInsert={noop} onInsertTemplate={noop} onToast={noop} />,
    );

    const attachBtn = screen.getByRole('button', { name: 'Attach files' });
    expect(attachBtn).not.toBeDisabled();
    // Clicking synchronously triggers the hidden <input type="file">'s click(),
    // not onAddFiles directly (that only fires from the input's change event) -
    // confirming the button is live (not swallowed by a disabled gate).
    await user.click(attachBtn);
  });
});

// ─── useUndoSend — cancellable send window ──────────────────────────────────

describe('useUndoSend — cancellable send window (email slice 7)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire the real send until the window elapses', () => {
    const { result } = renderHook(() => useUndoSend<{ to: string }>());
    const fire = vi.fn();

    act(() => {
      result.current.schedule({ to: 'a@x.com' }, fire, 10_000);
    });

    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(fire).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('Undo cancels the timer and hands back the exact queued draft - the send never fires', () => {
    const { result } = renderHook(() => useUndoSend<{ to: string }>());
    const fire = vi.fn();
    const draft = { to: 'b@x.com' };

    act(() => {
      result.current.schedule(draft, fire, 10_000);
    });

    let restored: { to: string } | null = null;
    act(() => {
      restored = result.current.undo();
    });
    expect(restored).toEqual(draft);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fire).not.toHaveBeenCalled();
  });

  it('undo() returns null when nothing is pending (already fired, or clicked twice)', () => {
    const { result } = renderHook(() => useUndoSend<{ to: string }>());

    act(() => {
      result.current.schedule({ to: 'c@x.com' }, vi.fn(), 10_000);
      result.current.undo();
    });

    let second: unknown;
    act(() => {
      second = result.current.undo();
    });
    expect(second).toBeNull();
  });
});

// ─── useSendEmail — multipart POST /emails ──────────────────────────────────

describe('useSendEmail — multipart POST /emails (email slice 7)', () => {
  function wrapper({ children }: { children: React.ReactNode }) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  it('posts a FormData body - text fields as strings, body JSON-encoded, files under `files`', async () => {
    mockApi.post.mockResolvedValue({ data: { email: {} } });
    const { result } = renderHook(() => useSendEmail(), { wrapper });
    const file = new File(['%PDF'], 'estimate.pdf', { type: 'application/pdf' });

    result.current.mutate({
      to: 'customer@example.com',
      cc: 'cc@example.com',
      subject: 'Your estimate',
      body: ['line one', 'line two'],
      job_id: 'job-1',
      customer_id: 'cust-1',
      files: [file],
    });

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    const [url, body, config] = mockApi.post.mock.calls[0]!;
    expect(url).toBe('/api/communication/emails');
    expect(body).toBeInstanceOf(FormData);
    const fd = body as FormData;
    expect(fd.get('to')).toBe('customer@example.com');
    expect(fd.get('cc')).toBe('cc@example.com');
    expect(fd.get('subject')).toBe('Your estimate');
    expect(fd.get('body')).toBe(JSON.stringify(['line one', 'line two']));
    expect(fd.get('job_id')).toBe('job-1');
    expect(fd.get('customer_id')).toBe('cust-1');
    expect(fd.get('files')).toBe(file);
    expect(config).toEqual({ headers: { 'Content-Type': 'multipart/form-data' } });
  });

  it('omits optional fields entirely rather than posting empty strings', async () => {
    mockApi.post.mockResolvedValue({ data: { email: {} } });
    const { result } = renderHook(() => useSendEmail(), { wrapper });

    result.current.mutate({ to: 'customer@example.com', body: ['hi'] });

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    const fd = mockApi.post.mock.calls[0]![1] as FormData;
    expect(fd.get('cc')).toBeNull();
    expect(fd.get('bcc')).toBeNull();
    expect(fd.get('job_id')).toBeNull();
    expect(fd.get('customer_id')).toBeNull();
    expect(fd.getAll('files')).toEqual([]);
  });
});
