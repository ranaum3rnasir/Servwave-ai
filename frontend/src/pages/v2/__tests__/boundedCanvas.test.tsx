/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 69: the two-pane messengers (text and chat) sit in a BOUNDED canvas - the canvas does
// not scroll, the breadcrumb row keeps its height and the page takes the rest - so the page and the
// canvas are never two vertical scrollers on one gesture.
//
// jsdom has no layout engine: the class the layout puts on the canvas, the predicate that decides
// it and the CSS rules that give the class its meaning are each pinned here; the measured result
// (no nested scroller, Send on screen) is in e2e/mobile/sms-chat-single-pane.spec.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';

import V2AppLayout from '../V2AppLayout';
import { isBoundedPage } from '../boundedPages';

vi.mock('@/components/copilot/CopilotProvider', () => ({ default: () => null }));
vi.mock('@/components/ai-center/AiCenterModal', () => ({ AiCenterModal: () => null }));
vi.mock('@/components/notifications/NotificationBell', () => ({
  NotificationBell: () => <button type="button" aria-label="Notifications" />,
}));
vi.mock('@/components/layout/GlobalSearch', () => ({
  default: ({ placeholder }: { placeholder?: string }) => <input aria-label="Search everything" placeholder={placeholder} />,
}));
vi.mock('@/lib/api/communication', () => ({
  useUnreadCounts: () => ({ sms: 0, whatsapp: 0, email: 0 }),
}));
vi.mock('@/lib/api/organization', () => ({ useOrganization: () => ({ data: { name: 'Test Org' } }) }));
vi.mock('@/lib/api/timeclock', () => ({
  useIsClockedIn: () => ({ isClockedIn: false, sinceTs: null, zoneLabel: null }),
  useRecordPunch: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        org_features: ['phone', 'email'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
      logout: vi.fn(),
    } as never),
  );
});

function canvasAt(pathname: string): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[pathname]}>
        <AbilityProvider ability={buildAbility([{ action: 'manage', subject: 'all' }])}>
          <Routes>
            <Route element={<V2AppLayout />}>
              <Route path="*" element={<div>a page</div>} />
            </Route>
          </Routes>
        </AbilityProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return document.querySelector<HTMLElement>('[data-slot="app-canvas-body"]')!;
}

describe('which pages are bounded', () => {
  it.each([
    '/communication/text',
    '/communication/text/settings',
    '/communication/whatsapp',
    '/Communication/Text',
    // The Phone hub (mobile slice 71): the call log takes the rest of the canvas.
    '/communication/phone',
    '/communication/phone/numbers',
    '/Communication/Phone',
  ])('%s is', (p) => expect(isBoundedPage(p)).toBe(true));

  it.each([
    '/communication/inbox',
    '/communication/textual',
    '/communication/phones',
    '/customers',
    '/schedule',
  ])('%s is not', (p) => expect(isBoundedPage(p)).toBe(false));
});

describe('the canvas the layout draws', () => {
  it('text is bounded', () => {
    expect(canvasAt('/communication/text')).toHaveClass('is-bounded');
  });

  it('the Phone hub is bounded too', () => {
    expect(canvasAt('/communication/phone')).toHaveClass('is-bounded');
  });

  it('chat is bounded too', () => {
    expect(canvasAt('/communication/whatsapp')).toHaveClass('is-bounded');
  });

  it('an ordinary page is neither bounded nor flush', () => {
    const canvas = canvasAt('/customers');
    expect(canvas).not.toHaveClass('is-bounded');
    expect(canvas).not.toHaveClass('is-flush');
  });

  it('the schedule stays flush, not bounded', () => {
    const canvas = canvasAt('/schedule');
    expect(canvas).toHaveClass('is-flush');
    expect(canvas).not.toHaveClass('is-bounded');
  });
});

describe('what the class means', () => {
  const css = readFileSync(path.resolve(__dirname, '../../../ui-kit/components/layout/shell.css'), 'utf8');
  const rule = (selector: string, from = 0): string => {
    const start = css.indexOf(selector, from);
    expect(start, `${selector} is in shell.css`).toBeGreaterThan(-1);
    return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  };

  it('the canvas stops scrolling and becomes a column the page can fill', () => {
    const body = rule('.canvas-body.is-bounded {');
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/min-height:\s*0/);
  });

  it('the breadcrumb row keeps its own height', () => {
    expect(rule('.canvas-body.is-bounded > [data-slot="breadcrumbs"]')).toMatch(/flex:\s*none/);
  });

  it('on a phone the page lifts over the on-screen keyboard', () => {
    const phone = css.indexOf('@media (max-width: 767.98px)');
    expect(phone).toBeGreaterThan(-1);
    const lifted = rule('.canvas-body.is-bounded {', css.indexOf('.shell {', phone));
    expect(lifted).toMatch(/padding-bottom:[^;]*var\(--keyboard-inset/);
    expect(lifted).toMatch(/env\(safe-area-inset-bottom/);
  });
});
