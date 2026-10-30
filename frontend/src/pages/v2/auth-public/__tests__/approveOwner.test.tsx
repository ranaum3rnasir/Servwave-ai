/**
 * The Make Owner approval page (ticket 27, D1): /approve-owner?token=..., opened from the email the Owner received.
 *
 * Seams: what the person sees, the address bar, the referrer policy, and the requests the page makes (the app's axios
 * instance, mocked in the vitest setup). Opening the page changes nothing: ownership moves only on Approve. A dead link says
 * so plainly. The server side is proved in backend `permission-make-owner-db.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Route, Routes, useLocation } from 'react-router-dom';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import ApproveOwnerPage from '@/pages/v2/auth-public/ApproveOwnerPage';

const EXPIRED = 'This approval link has expired or has already been used. Nothing was changed.';
const secret = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
let token: string;

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function openLink(search: string) {
  window.history.replaceState(null, '', `/approve-owner${search}`);
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/approve-owner" element={<ApproveOwnerPage />} />
        <Route path="/" element={<p>home</p>} />
      </Routes>
      <Where />
    </>,
    { initialEntries: [`/approve-owner${search}`] },
  );
}

const expired = () => Promise.reject({ response: { status: 400, data: { error: EXPIRED, code: 'owner_link_expired' } } });

beforeEach(() => {
  vi.clearAllMocks();
  token = secret();
});
afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('approve-owner page', () => {
  it('opening the link changes nothing: it shows who becomes the Owner, and moves ownership only on Approve', async () => {
    vi.mocked(api.post).mockImplementation((() =>
      Promise.resolve({ data: { company_name: 'Acme Test Co', new_owner_name: 'Bea Ready' } })) as never);
    const user = userEvent.setup();
    openLink(`?token=${token}`);

    expect(await screen.findByText('Make Bea Ready the Owner of Acme Test Co? You stay an Admin.')).toBeInTheDocument();
    expect(vi.mocked(api.post).mock.calls.map((c) => c[0])).toEqual(['/api/auth/owner-approval']);
    // The token left the address bar, and went only in the body.
    expect(window.location.search).toBe('');
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/approve-owner$/);
    expect(vi.mocked(api.post).mock.calls[0]![1]).toEqual({ token });

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Ownership moved')).toBeInTheDocument();
    expect(screen.getByText(/Bea Ready is now the Owner of Acme Test Co\. You.re still an Admin\./)).toBeInTheDocument();
    expect(vi.mocked(api.post).mock.calls.map((c) => c[0])).toEqual(['/api/auth/owner-approval', '/api/auth/owner-approval/approve']);
    expect(vi.mocked(api.post).mock.calls[1]![1]).toEqual({ token });
  });

  it('a dead link says it expired or was used, and offers no Approve', async () => {
    vi.mocked(api.post).mockImplementation((() => expired()) as never);
    openLink(`?token=${token}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(EXPIRED);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('a link used up between opening and approving says so', async () => {
    vi.mocked(api.post)
      .mockImplementationOnce((() => Promise.resolve({ data: { company_name: 'Acme Test Co', new_owner_name: 'Bea Ready' } })) as never)
      .mockImplementationOnce((() => expired()) as never);
    const user = userEvent.setup();
    openLink(`?token=${token}`);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(EXPIRED);
    expect(screen.queryByText('Ownership moved')).toBeNull();
  });

  it('opened with no token asks for the email link again and calls nothing', async () => {
    openLink('');
    expect(await screen.findByRole('alert')).toHaveTextContent('Open the approval link from your email again.');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('is served with no-referrer, so the first load never passes the link on', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const vercel = JSON.parse(readFileSync(join(here, '../../../../../vercel.json'), 'utf8')) as {
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    const values = vercel.headers
      .filter((r) => new RegExp(`^${r.source.replace(/\(\.\*\)/g, '.*')}$`).test('/approve-owner'))
      .flatMap((r) => r.headers)
      .filter((h) => h.key === 'Referrer-Policy')
      .map((h) => h.value);
    expect(values.at(-1)).toBe('no-referrer');
  });
});
