/**
 * Attach files while creating a task (visits-and-task-categories slice 13).
 *
 * Both create dialogs - the Tasks page (v2) and the legacy one the job/lead/customer/estimate task
 * tabs mount - queue picked files locally, create the task, and only then upload each file to the
 * new task. The storage boundary is mocked: the API client (global harness mock) and the chunked
 * upload client (the shared double). `uploadAttachment` itself runs for real, so the transport
 * choice (multipart vs. resumable video) is the production one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import type { Task } from '@/lib/tasks/types';
import { CreateTaskDialog } from '@/pages/v2/tasks/components/createTaskDialog';
import { CreateTaskModal } from '@/components/tasks/CreateTaskModal';
import { resetChunkedUploads } from './support/chunkedUploadDouble';

vi.mock('tus-js-client', async () => {
  const { chunkedUploadModule } = await import('./support/chunkedUploadDouble');
  return chunkedUploadModule();
});

const NEW_ID = 't_new';

function makeTask(): Task {
  return {
    id: NEW_ID,
    task_number: 'T00042',
    title: 'Order the closer',
    description: '',
    status: 'TODO',
    priority: 'MEDIUM',
    assignee_ids: [],
    assignees: [],
    watcher_ids: [],
    due_at: null,
    linked_entity: null,
    tags: [],
    subtasks: [],
    created_by: 'me',
    created_at: '2026-09-28T12:00:00.000Z',
    updated_at: '2026-09-28T12:00:00.000Z',
    completed_at: null,
    activity: [],
    comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    attachment_count: 0,
  };
}

const mockAddTask = vi.fn();
const mockSetAttachmentCount = vi.fn();

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: vi.fn((sel?: (s: unknown) => unknown) => {
    const state = { tasks: [], addTask: mockAddTask, setAttachmentCount: mockSetAttachmentCount };
    return sel ? sel(state) : state;
  }),
}));

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: [], isLoading: false })),
}));

vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: ({ id }: { id?: string }) => <div data-testid={id ?? 'multi-assignee-select'} />,
}));

const mockApi = vi.mocked(api);

function doc(name: string, type = 'application/pdf', size = 1024): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

/** The multipart POSTs that reached the task attachment route, as file names, in order. */
function uploadedNames(): string[] {
  return mockApi.post.mock.calls
    .filter(([url]) => url === `/api/attachments/task/${NEW_ID}`)
    .map(([, body]) => ((body as FormData).get('file') as File).name);
}

const DIALOGS = [
  ['Tasks page', CreateTaskDialog],
  ['entity task tab (legacy)', CreateTaskModal],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  resetChunkedUploads();
  localStorage.clear();
  mockAddTask.mockResolvedValue(makeTask());
  mockApi.get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === '/api/task-categories' ? { categories: [] } : {} }),
  );
  mockApi.post.mockResolvedValue({ data: {} });
});

function setup(Dialog: (typeof DIALOGS)[number][1]) {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  const view = renderWithProviders(<Dialog open onOpenChange={onOpenChange} />);
  const fileInput = () => screen.getByLabelText('Files to attach') as HTMLInputElement;
  const typeTitle = () => user.type(screen.getByPlaceholderText('Task title'), 'Order the closer');
  const create = () => user.click(screen.getByRole('button', { name: 'Create' }));
  return { user, onOpenChange, fileInput, typeTitle, create, ...view };
}

describe.each(DIALOGS)('%s create dialog - files picked while creating', (_name, Dialog) => {
  it('creates the task first, then uploads each queued file to the new task', async () => {
    const { user, onOpenChange, fileInput, typeTitle, create } = setup(Dialog);
    await typeTitle();
    await user.upload(fileInput(), [doc('plate.pdf'), doc('quote.pdf')]);

    // Queued, not sent: nothing has left the browser before the task exists.
    expect(screen.getByText('plate.pdf')).toBeInTheDocument();
    expect(screen.getByText('quote.pdf')).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalled();

    await create();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(uploadedNames()).toEqual(['plate.pdf', 'quote.pdf']);
    // The task existed before the first byte left.
    expect(mockAddTask.mock.invocationCallOrder[0]).toBeLessThan(
      mockApi.post.mock.invocationCallOrder[0],
    );
  });
});

describe.each(DIALOGS)('%s create dialog - a file that fails', (_name, Dialog) => {
  function failFor(name: string) {
    mockApi.post.mockImplementation((url: string, body?: unknown) => {
      const sent = body instanceof FormData ? (body.get('file') as File).name : null;
      return sent === name
        ? Promise.reject({ response: { data: { error: 'The file could not be stored.' } } })
        : Promise.resolve({ data: {} });
    });
  }

  it('leaves the task created, names the file that failed, and keeps going', async () => {
    failFor('quote.pdf');
    const { user, onOpenChange, fileInput, typeTitle, create } = setup(Dialog);
    await typeTitle();
    await user.upload(fileInput(), [doc('plate.pdf'), doc('quote.pdf'), doc('photo.pdf')]);
    await create();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Task created, but 1 file didn\'t upload: "quote.pdf"');
    expect(screen.getByText("Didn't upload: The file could not be stored.")).toBeInTheDocument();
    // The task stays: one create, never rolled back; the file after the failure still went.
    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(uploadedNames()).toEqual(['plate.pdf', 'quote.pdf', 'photo.pdf']);
    expect(onOpenChange).not.toHaveBeenCalled();
    // The board card counts only what landed.
    expect(mockSetAttachmentCount).toHaveBeenLastCalledWith(NEW_ID, 2);
  });

  it('retries the failed file against the same task, and the card count follows', async () => {
    failFor('quote.pdf');
    const { user, onOpenChange, fileInput, typeTitle, create } = setup(Dialog);
    await typeTitle();
    await user.upload(fileInput(), [doc('plate.pdf'), doc('quote.pdf')]);
    await create();
    await screen.findByRole('alert');

    mockApi.post.mockResolvedValue({ data: {} });
    await user.click(screen.getByRole('button', { name: 'Retry quote.pdf' }));

    await waitFor(() => expect(mockSetAttachmentCount).toHaveBeenLastCalledWith(NEW_ID, 2));
    expect(uploadedNames()).toEqual(['plate.pdf', 'quote.pdf', 'quote.pdf']);
    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('uploads nothing when the task itself could not be created, and keeps the queue', async () => {
    mockAddTask.mockRejectedValue({ response: { data: { error: 'Title is required' } } });
    const { user, onOpenChange, fileInput, typeTitle, create } = setup(Dialog);
    await typeTitle();
    await user.upload(fileInput(), [doc('plate.pdf')]);
    await create();

    await waitFor(() => expect(mockAddTask).toHaveBeenCalledTimes(1));
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText('plate.pdf')).toBeInTheDocument();
  });
});

describe.each(DIALOGS)('%s create dialog - cancelling and double clicks', (_name, Dialog) => {
  it('Cancel discards the queue and uploads nothing', async () => {
    const { user, onOpenChange, fileInput, typeTitle, rerender } = setup(Dialog);
    await typeTitle();
    await user.upload(fileInput(), [doc('plate.pdf')]);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockApi.post).not.toHaveBeenCalled();
    // Opened again, the old pick is gone.
    rerender(<Dialog open={false} onOpenChange={onOpenChange} />);
    rerender(<Dialog open onOpenChange={onOpenChange} />);
    expect(screen.queryByText('plate.pdf')).not.toBeInTheDocument();
  });

  it('Escape discards the queue and uploads nothing', async () => {
    const { user, onOpenChange, fileInput } = setup(Dialog);
    await user.upload(fileInput(), [doc('plate.pdf')]);
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('a removed file is not uploaded', async () => {
    const { user, fileInput, typeTitle, create } = setup(Dialog);
    await typeTitle();
    await user.upload(fileInput(), [doc('plate.pdf'), doc('quote.pdf')]);
    await user.click(screen.getByRole('button', { name: 'Remove plate.pdf' }));
    await create();
    await waitFor(() => expect(uploadedNames()).toEqual(['quote.pdf']));
  });

  it('a double click creates the task once and uploads each file once', async () => {
    let finish: (t: Task) => void = () => {};
    mockAddTask.mockImplementation(() => new Promise<Task>((r) => { finish = r; }));
    const { user, onOpenChange, fileInput, typeTitle } = setup(Dialog);
    await typeTitle();
    await user.upload(fileInput(), [doc('plate.pdf')]);

    // Both clicks inside one act: the second lands before React has painted the disabled
    // button, which is the window a real double click (or click + Enter) can hit.
    const createButton = screen.getByRole('button', { name: 'Create' });
    act(() => {
      createButton.click();
      createButton.click();
    });
    await act(async () => finish(makeTask()));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(uploadedNames()).toEqual(['plate.pdf']);
  });
});

describe.each(DIALOGS)('%s create dialog - closing while the task is being created', (_name, Dialog) => {
  it.each([
    ['Escape', async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
    ['the X', async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: /close/i }))],
  ])('%s does nothing until the create settles, and then the queued files still go', async (_how, close) => {
    let finish: (t: Task) => void = () => {};
    mockAddTask.mockImplementation(() => new Promise<Task>((r) => { finish = r; }));
    const { user, onOpenChange, fileInput, typeTitle, create } = setup(Dialog);
    await typeTitle();
    await user.upload(fileInput(), [doc('plate.pdf')]);
    await create();

    await close(user);
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => finish(makeTask()));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(uploadedNames()).toEqual(['plate.pdf']);
  });
});

describe.each(DIALOGS)('%s create dialog - a cancel that lands too late', (_name, Dialog) => {
  /** The multipart POST hangs until its signal aborts, like a transfer the user stops. */
  function hangUntilCancelled() {
    mockApi.post.mockImplementation((_url: string, _body?: unknown, config?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        config?.signal?.addEventListener('abort', () => reject(new Error('canceled')));
      }));
  }
  /** What the server holds for the new task when the dialog re-reads it. */
  function serverHas(rows: { file_name: string; file_size: number }[]) {
    mockApi.get.mockImplementation((url: string) =>
      Promise.resolve({
        data: url === `/api/attachments/task/${NEW_ID}`
          ? { attachments: rows.map((r, i) => ({ id: `a${i}`, ...r })) }
          : url === '/api/task-categories' ? { categories: [] } : {},
      }));
  }
  async function cancelWhileUploading(Dialog: (typeof DIALOGS)[number][1]) {
    hangUntilCancelled();
    const view = setup(Dialog);
    await view.typeTitle();
    await view.user.upload(view.fileInput(), [doc('plate.pdf')]);
    await view.create();
    await view.user.click(await screen.findByRole('button', { name: 'Cancel upload' }));
    return view;
  }

  it('a file the server received anyway is shown as uploaded, counted, and offers no Retry', async () => {
    serverHas([{ file_name: 'plate.pdf', file_size: 1024 }]);
    const { user, onOpenChange } = await cancelWhileUploading(Dialog);

    expect(await screen.findByText('Uploaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry plate.pdf' })).not.toBeInTheDocument();
    expect(mockApi.get).toHaveBeenCalledWith(`/api/attachments/task/${NEW_ID}`);
    expect(mockSetAttachmentCount).toHaveBeenLastCalledWith(NEW_ID, 1);

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a file the server does not have offers Retry, which sends it once', async () => {
    serverHas([]);
    const { user } = await cancelWhileUploading(Dialog);

    expect(await screen.findByText('Upload cancelled')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Task created with 0 files. 1 cancelled');
    mockApi.post.mockResolvedValue({ data: {} });
    await user.click(screen.getByRole('button', { name: 'Retry plate.pdf' }));

    await waitFor(() => expect(mockSetAttachmentCount).toHaveBeenLastCalledWith(NEW_ID, 1));
    expect(uploadedNames()).toEqual(['plate.pdf', 'plate.pdf']);
  });

  it('Retry looks again first: a file that landed after the cancel is not sent twice', async () => {
    serverHas([]);
    const { user } = await cancelWhileUploading(Dialog);
    await screen.findByText('Upload cancelled');

    // The server finished writing it after the first look.
    serverHas([{ file_name: 'plate.pdf', file_size: 1024 }]);
    mockApi.post.mockResolvedValue({ data: {} });
    await user.click(screen.getByRole('button', { name: 'Retry plate.pdf' }));

    expect(await screen.findByText('Uploaded')).toBeInTheDocument();
    expect(uploadedNames()).toEqual(['plate.pdf']);
    expect(mockSetAttachmentCount).toHaveBeenLastCalledWith(NEW_ID, 1);
  });
});

describe.each(DIALOGS)('%s create dialog - limits are checked before create', (_name, Dialog) => {
  it('refuses an oversized file and a type the server would refuse, by name, and never sends them', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const onOpenChange = vi.fn();
    renderWithProviders(<Dialog open onOpenChange={onOpenChange} />);
    await user.type(screen.getByPlaceholderText('Task title'), 'Order the closer');

    await user.upload(screen.getByLabelText('Files to attach'), [
      doc('huge.pdf', 'application/pdf', 26 * 1024 * 1024),
      doc('setup.exe', 'application/x-msdownload'),
      doc('plate.pdf'),
    ]);

    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts).toContain(
      '"huge.pdf" is 26 MB — over the 25 MB limit, so it wasn\'t uploaded. Contact support to send it another way.',
    );
    expect(alerts.some((a) => a?.startsWith('"setup.exe" can\'t be attached.'))).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(uploadedNames()).toEqual(['plate.pdf']);
  });

  it('brings the first refusal into view, so a phone user below the fold sees it', async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    try {
      const user = userEvent.setup({ applyAccept: false });
      renderWithProviders(<Dialog open onOpenChange={vi.fn()} />);
      await user.upload(screen.getByLabelText('Files to attach'), [
        doc('setup.exe', 'application/x-msdownload'),
        doc('run.bat', 'application/x-bat'),
      ]);

      const [first] = screen.getAllByRole('alert');
      await waitFor(() => expect(scrolled).toContain(first));
      expect(first).toHaveTextContent('"setup.exe" can\'t be attached.');
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('accepts a video up to the video cap and sends it on the resumable path to the new task', async () => {
    mockApi.post.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/direct-upload')
          ? { data: { upload: { bucket: 'attachments', path: 'org/t/clip.mp4', token: 'tok', ticket: 'tkt' } } }
          : { data: {} },
      ),
    );
    const { RecordedChunkedUpload } = await import('./support/chunkedUploadDouble');
    RecordedChunkedUpload.startBehaviour = 'success';
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co');

    const { user, onOpenChange, fileInput, typeTitle, create } = setup(Dialog);
    await typeTitle();
    await user.upload(fileInput(), [doc('walkthrough.mp4', 'video/mp4', 300 * 1024 * 1024)]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await create();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const urls = mockApi.post.mock.calls.map(([url]) => url);
    expect(urls).toEqual([
      `/api/attachments/task/${NEW_ID}/direct-upload`,
      `/api/attachments/task/${NEW_ID}/direct-upload/complete`,
    ]);
    expect(RecordedChunkedUpload.instances).toHaveLength(1);
    expect(mockSetAttachmentCount).toHaveBeenLastCalledWith(NEW_ID, 1);
    vi.unstubAllEnvs();
  });
});

describe.each(DIALOGS)('%s create dialog - the file control', (_name, Dialog) => {
  it('is a labelled group with a keyboard-reachable Browse that opens the picker', async () => {
    const { user } = setup(Dialog);
    const group = screen.getByRole('group', { name: 'Files' });
    const browse = screen.getByRole('button', { name: 'Browse' });
    expect(group).toContainElement(browse);

    const click = vi.spyOn(screen.getByLabelText('Files to attach'), 'click');
    browse.focus();
    await user.keyboard('{Enter}');
    expect(click).toHaveBeenCalled();
  });

  it('does not close while a file is still uploading', async () => {
    let land: () => void = () => {};
    mockApi.post.mockImplementation(() => new Promise((r) => { land = () => r({ data: {} }); }));
    const { user, onOpenChange, fileInput, typeTitle, create } = setup(Dialog);
    await typeTitle();
    await user.upload(fileInput(), [doc('plate.pdf')]);
    await create();
    await screen.findByText('Task created. Uploading files…');

    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Uploading…' })).toBeDisabled();

    land();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe.each(DIALOGS)('%s create dialog - a list open over the dialog (slice 07)', (_name, Dialog) => {
  it('the first backdrop click closes only the list; the queued file stays and nothing is sent', async () => {
    mockApi.get.mockImplementation((url: string) =>
      Promise.resolve({
        data: url === '/api/task-categories'
          ? { categories: [{ id: 'c1', name: 'Part order', color: '#F97316' }] }
          : {},
      }),
    );
    const { user, onOpenChange, fileInput } = setup(Dialog);
    await user.upload(fileInput(), [doc('plate.pdf')]);
    const scrim = screen.getAllByRole('dialog')[0].previousElementSibling as HTMLElement;

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await screen.findByRole('option', { name: 'Part order' });
    await user.click(scrim);

    await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText('plate.pdf')).toBeInTheDocument();

    await user.click(scrim);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});
