/**
 * #2980 - History names the deposit method the customer chose, and each change, in words. No raw
 * method code reaches the screen (spec #2978: "Customer chose Check for the deposit" / "Customer
 * changed the deposit method from Check to Credit/Debit Card").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { HistoryPanel } from '@/features/estimate-workspace/components/HistoryPanel';
import { DEPOSIT_METHOD_LABELS } from '@/features/estimate-workspace/lib/depositMethodHistory';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every value of the backend's PaymentMethod enum, read from the schema itself, so a value added
 * there fails here until History has words for it.
 */
const PAYMENT_METHODS: string[] = (() => {
  const schema = readFileSync(join(__dirname, '..', '..', '..', 'backend', 'prisma', 'schema.prisma'), 'utf8');
  const body = /enum PaymentMethod \{([^}]*)\}/.exec(schema)?.[1] ?? '';
  return body.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter((l) => /^[A-Z_]+$/.test(l));
})();

const pick = (id: string, metadata: Record<string, unknown> | null, at: string) =>
  ({ id, action: 'estimate.deposit_method_selected', actor_email: null, metadata, created_at: at });

function mockApi(events: unknown[]) {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url.endsWith('/history')) return Promise.resolve({ data: { events } } as never);
    if (url.endsWith('/versions')) return Promise.resolve({ data: { versions: [] } } as never);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

beforeEach(() => vi.clearAllMocks());

const open = () => renderWithProviders(<HistoryPanel open onClose={() => {}} estimateId="est-1" />);

describe('History names the deposit method', () => {
  it('a first pick and each change, newest first, in words', async () => {
    mockApi([
      pick('p-3', { via: 'deposit_checkout', method: 'CARD', previous_method: 'CHECK' }, '2026-10-30T15:05:00Z'),
      { id: 'c-1', action: 'estimate.deposit_checkout_started', actor_email: null, metadata: {}, created_at: '2026-10-30T15:05:00Z' },
      pick('p-2', { via: 'manual_method', method: 'CHECK', previous_method: 'CARD' }, '2026-10-30T14:51:00Z'),
      pick('p-1', { via: 'manual_method', method: 'ZELLE', previous_method: null }, '2026-10-30T14:42:00Z'),
    ]);
    open();

    expect(await screen.findByText('Customer changed the deposit method from Check to Credit/Debit Card')).toBeInTheDocument();
    expect(screen.getByText('Customer changed the deposit method from Credit/Debit Card to Check')).toBeInTheDocument();
    expect(screen.getByText('Customer chose Zelle for the deposit')).toBeInTheDocument();
    expect(screen.getByText('Customer started deposit checkout')).toBeInTheDocument();
  });

  it('reads the whole enum from the schema', () => {
    expect(PAYMENT_METHODS).toEqual(expect.arrayContaining(['CARD', 'ACH', 'EXTERNAL_CARD', 'CHECK', 'ZELLE']));
    expect(PAYMENT_METHODS.length).toBeGreaterThanOrEqual(10);
  });

  it.each(PAYMENT_METHODS)('%s reads in words, as a first pick and in a change, never as its code', async (code) => {
    const words = DEPOSIT_METHOD_LABELS[code];
    expect(words, `${code} has History words`).toBeTruthy();
    const other = code === 'CHECK' ? 'ZELLE' : 'CHECK';
    mockApi([
      pick('p-2', { method: other, previous_method: code }, '2026-10-30T14:51:00Z'),
      pick('p-1', { method: code, previous_method: null }, '2026-10-30T14:42:00Z'),
    ]);
    const { container } = open();
    expect(await screen.findByText(`Customer chose ${words} for the deposit`)).toBeInTheDocument();
    expect(screen.getByText(`Customer changed the deposit method from ${words} to ${DEPOSIT_METHOD_LABELS[other]}`)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(new RegExp(`(^|[^A-Za-z_])${code}([^A-Za-z_]|$)`));
  });

  it('a pick recorded before the method rode the event, or with an unknown method, keeps the generic line', async () => {
    mockApi([
      pick('p-2', { method: 'SOMETHING_NEW', previous_method: 'CHECK' }, '2026-10-30T14:51:00Z'),
      pick('p-1', { via: 'manual_method' }, '2026-10-30T14:42:00Z'),
    ]);
    const { container } = open();
    expect(await screen.findAllByText('Customer chose a deposit payment method')).toHaveLength(2);
    expect(container.textContent).not.toContain('SOMETHING_NEW');
  });
});
