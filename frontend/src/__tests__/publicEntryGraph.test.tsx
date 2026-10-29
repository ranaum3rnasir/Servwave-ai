/**
 * Mobile slice 47 (PRD module 7, PUB-03): public pages load without the staff app.
 *
 * The page a customer opens from an emailed link is its own entry (`public.html` ->
 * `public-main.tsx` -> `PublicApp.tsx`). Three things keep that true and are pinned here:
 *
 *  1. WHAT IT IMPORTS. The entry's static import graph never reaches the staff layout, the route
 *     table, the auth store, the signed-in API client, the data-fetching library or the identity
 *     SDK. (The build-time budget check measures bytes; this names the culprit when it trips and
 *     also catches a regression that the budget has room to absorb.)
 *  2. WHAT IT ROUTES. Its two routes are the two `/p/` routes the staff table also declares.
 *  3. THAT IT WORKS with none of the providers the staff app wraps every page in: it is rendered
 *     here bare, so a page that quietly started needing a query client, ability or tooltip
 *     provider fails this suite instead of white-screening on a customer's phone.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CAPTURED, PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING } from '@/__tests__/fixtures/public-estimate-payload';
import { PublicRoutes } from '@/PublicApp';
import { replaceLocation } from '@/lib/platform/replaceLocation';
import { importChain, relativeToSrc, staticImportGraph } from './staticImportGraph';
import { parseRoutes } from '@/pages/v2/__tests__/routeTable';

vi.mock('react-signature-canvas', () => ({
  default: vi.fn().mockImplementation(() => null),
}));
vi.mock('@/lib/platform/replaceLocation', () => ({ replaceLocation: vi.fn() }));

const SRC = resolve(__dirname, '..');
const graph = staticImportGraph(join(SRC, 'public-main.tsx'));

/** Files and packages no customer-facing page may pull in. Each line says what it would cost. */
const FORBIDDEN_FILES: [RegExp, string][] = [
  [/^pages\/v2\/V2AppLayout/, 'the staff shell (sidebar, top bar, drawer)'],
  [/^pages\/v2\/V2Routes/, 'the staff route table'],
  [/^pages\/v2\/routes\//, 'the staff route modules, which import every staff page'],
  [/^App\.tsx$/, 'the staff app root'],
  [/^stores\//, 'the auth store and the other staff stores'],
  [/^lib\/axios/, 'the signed-in API client'],
  [/^lib\/supabase/, 'the identity SDK client'],
  [/^lib\/queryClient/, 'the staff query client'],
  [/^lib\/api\//, 'the signed-in data hooks (publicLostReasons is the one public exception)'],
  [/^contexts\//, 'the staff providers'],
  [/^services\/copilot|^components\/copilot|^lib\/copilot/, 'the AI copilot'],
];
const ALLOWED_API = new Set(['lib/api/publicLostReasons.ts']);

const FORBIDDEN_PACKAGES = [
  '@supabase/supabase-js',
  'axios',
  '@tanstack/react-query',
  '@tanstack/react-table',
  'date-fns-tz',
  'date-fns',
  'zustand',
  'sonner',
  'framer-motion',
  'recharts',
  'react-big-calendar',
  '@dnd-kit/core',
  // The popover stack (positioning, focus trap, scroll lock) is about 14 KB gzipped. The Button's
  // tap-to-explain bubble used to import it statically, which put it on every customer page; the
  // bubble now loads when someone taps a disabled button (mobile slice 47 fix).
  '@radix-ui/react-popover',
  '@floating-ui/dom',
];

describe('the public entry imports nothing from the staff app', () => {
  it('walks a real graph: the entry, the app, both pages and the shared primitives', () => {
    const files = [...graph.files].map(relativeToSrc);
    expect(files).toEqual(
      expect.arrayContaining([
        'public-main.tsx',
        'PublicApp.tsx',
        'instrument-public.ts',
        'pages/v2/auth-public/PublicEstimatePage.tsx',
        'pages/v2/auth-public/PublicInvoicePage.tsx',
      ]),
    );
    expect(files.length).toBeGreaterThan(25);
  });

  it('reaches no staff shell, route table, store, signed-in client or provider', () => {
    const offenders: string[] = [];
    for (const file of graph.files) {
      const rel = relativeToSrc(file);
      if (ALLOWED_API.has(rel)) continue;
      for (const [pattern, what] of FORBIDDEN_FILES) {
        if (pattern.test(rel)) offenders.push(`${importChain(graph, file).join(' -> ')}   [${what}]`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('pulls in no package that exists for the signed-in app', () => {
    expect([...graph.packages].filter((p) => FORBIDDEN_PACKAGES.includes(p))).toEqual([]);
  });

  it('does not use the eager route glob anywhere in its graph', () => {
    const globbing = [...graph.files]
      .filter((f) => readFileSync(f, 'utf8').includes('import.meta.glob'))
      .map(relativeToSrc);
    expect(globbing).toEqual([]);
  });

  it('keeps session replay and the decline dialog behind import(), out of the static graph', () => {
    const files = [...graph.files].map(relativeToSrc);
    expect(files).not.toContain('lib/observability/replay.ts');
    expect(files).not.toContain('pages/v2/auth-public/components/declineDialog.tsx');
    expect(files).not.toContain('pages/v2/auth-public/components/declineReasonFields.tsx');
  });

  it('starts error reporting from the public instrument file, not the staff one with tracing', () => {
    const files = [...graph.files].map(relativeToSrc);
    expect(files).toContain('instrument-public.ts');
    expect(files).not.toContain('instrument.ts');
  });
});

describe('the public routes are the same two the staff table declares', () => {
  const publicPaths = [...readFileSync(join(SRC, 'PublicApp.tsx'), 'utf8').matchAll(/<Route\s+path="(\/p\/[^"]+)"/g)]
    .map((m) => m[1]!)
    .sort();
  const staffSource = readFileSync(join(SRC, 'pages/v2/routes/auth-public.routes.tsx'), 'utf8');
  const staffPublic = parseRoutes(staffSource, 0, 'auth-public.routes.tsx')
    .filter((r) => r.path.startsWith('/p/'))
    .map((r) => r.path)
    .sort();

  it('declares exactly the /p/ routes that auth-public.routes.tsx declares, unguarded', () => {
    expect(publicPaths).toEqual(['/p/estimates/:id', '/p/invoices/:id']);
    expect(publicPaths).toEqual(staffPublic);
    for (const route of parseRoutes(staffSource, 0, 'auth-public.routes.tsx').filter((r) => r.path.startsWith('/p/'))) {
      expect(route.guards, `${route.path} must stay unguarded`).toEqual([]);
    }
  });
});

describe('PublicRoutes renders with none of the staff providers', () => {
  const API_HOST = 'https://api.host.test';

  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', API_HOST);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  function bare(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <PublicRoutes />
      </MemoryRouter>,
    );
  }

  it('shows a public invoice at /p/invoices/:id', async () => {
    const payload = {
      invoice: {
        id: 'inv-1',
        invoice_number: 'I00042',
        status: 'SENT',
        kind: 'STANDARD',
        subtotal: 500,
        discount_amount: 0,
        tax_amount: 0,
        deposit_credit: 0,
        total_amount: 500,
        amount_due: 500,
        due_date: '2020-01-01T00:00:00.000Z',
        sent_at: '2026-03-01T00:00:00.000Z',
        paid_at: null,
        created_at: '2026-03-01T00:00:00.000Z',
        job: null,
        customer: { first_name: 'Pat', last_name: 'Payer' },
        line_items: [
          { id: 'li-1', sequence: 1, description: 'Door service', quantity: 1, unit_price: 500, is_taxable: false, line_total: 500 },
        ],
        payments: [],
      },
      organization: { name: 'Test Services Co' },
      available_payment_methods: [],
      payment_instructions: {},
    };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal('fetch', fetchSpy);

    bare('/p/invoices/inv-1?token=tok-1');

    expect(await screen.findByText('Door service')).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalled();
    // The overdue test the invoice page runs (orgDayDiffIntl) still flags a long-past due date.
    expect(await screen.findByText(/This invoice was due on/i)).toBeInTheDocument();
  });

  it('shows a public estimate at /p/estimates/:id', async () => {
    const payload = structuredClone(PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING) as Record<string, unknown>;
    const estimate = payload.estimate as Record<string, unknown>;
    estimate.invoices = [];
    estimate.send_config = null;
    estimate.status = 'SENT';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));

    bare(`/p/estimates/${CAPTURED.estimateId}?token=tok-1`);

    expect(await screen.findByText('Door install')).toBeInTheDocument();
  });

  it('opens the decline dialog, with its reason picker, from the lazily loaded chunk', async () => {
    const payload = structuredClone(PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING) as Record<string, unknown>;
    const estimate = payload.estimate as Record<string, unknown>;
    estimate.invoices = [];
    estimate.send_config = null;
    estimate.status = 'SENT';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
    const { default: userEvent } = await import('@testing-library/user-event');

    bare(`/p/estimates/${CAPTURED.estimateId}?token=tok-1`);
    await screen.findByText('Door install');
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Decline$/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
  });

  it('hands any other /p/ URL to the staff app with a full load', async () => {
    bare('/p/anything-else');
    await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith('/'));
  });
});
