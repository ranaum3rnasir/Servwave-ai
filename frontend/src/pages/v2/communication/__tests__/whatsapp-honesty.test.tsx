/// <reference types="@testing-library/jest-dom/vitest" />
// SRVW-133 - locks the WhatsApp honesty fix: no fabricated connection badge,
// no hardcoded third-party number, no simulated delivery/read ticks, and a
// real org's send is refused (409) with the optimistic bubble and draft
// rolled back instead of a false success.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import type { WAChat } from '@/lib/api/communication-shared';

const seed = vi.hoisted(() => ({ current: [] as WAChat[] }));
const sendMock = vi.hoisted(() => ({
  current: { mutate: vi.fn() } as {
    mutate: (v: unknown, o?: { onError?: (e: unknown) => void }) => void;
  },
}));

vi.mock('@/lib/api/communication', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/communication')>();
  return {
    ...actual,
    useWhatsAppChats: () => ({ data: seed.current }),
    useSendWhatsApp: () => sendMock.current,
  };
});

import WhatsAppPage from '@/pages/v2/communication/WhatsAppPage';
import { whatsAppSendErrorMessage } from '@/lib/api/communication';

function baseChat(overrides: Partial<WAChat> = {}): WAChat {
  return {
    id: 'chat-1',
    name: 'Jordan Lee',
    org: 'Lee HVAC',
    phone: '(212) 555-0100',
    unread: 0,
    lastAt: '9:00 AM',
    messages: [
      { id: 'm1', from: 'them', text: 'hey there', at: '8:59 AM' },
    ],
    ...overrides,
  };
}

describe('WhatsAppPage honesty', () => {
  beforeEach(() => {
    seed.current = [baseChat()];
    sendMock.current = { mutate: vi.fn() };
  });

  it('renders no Connected badge and no hardcoded business number', () => {
    renderWithProviders(<WhatsAppPage />);
    expect(screen.queryByText(/Business\s*·\s*Connected/)).not.toBeInTheDocument();
    expect(screen.queryByText('(551) 282-7064')).not.toBeInTheDocument();
    expect(screen.getByText(/^Not connected$/i)).toBeInTheDocument();
  });

  it('a sent bubble keeps the server status - no delivery/read tick progression', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderWithProviders(<WhatsAppPage />);
      expect(container.querySelectorAll('.lucide-check-check')).toHaveLength(0);

      const input = screen.getByPlaceholderText('Type a message');
      fireEvent.change(input, { target: { value: 'hello there' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(container.querySelectorAll('.lucide-check-check')).toHaveLength(0);
      expect(container.querySelector('.lucide-check')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 409 send removes the optimistic bubble, restores the draft and says it was not sent', () => {
    sendMock.current = {
      mutate: (_v, o) =>
        o?.onError?.({
          response: {
            data: {
              code: 'WHATSAPP_NOT_CONNECTED',
              error: 'No WhatsApp Business account is connected for this organization',
            },
          },
        }),
    };
    renderWithProviders(<WhatsAppPage />);

    const input = screen.getByPlaceholderText('Type a message') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello there' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.queryByText('hello there')).not.toBeInTheDocument();
    expect(input.value).toBe('hello there');
    // TWO elements carry role="status" here: the header's connection chip and
    // this send-error line. The old bare `getByRole('status')` matched the one
    // element the legacy page had, and both of these contain "not connected",
    // so matching that phrase would no longer prove WHICH one rendered. The
    // assertion targets the sentence only the send error carries, and pins the
    // role on that element - narrower than what it replaced, not looser.
    const sendError = screen.getByText(/this message was not sent/i);
    expect(sendError).toHaveAttribute('role', 'status');
  });

  it('whatsAppSendErrorMessage maps the 409 code and falls back to the server error', () => {
    expect(
      whatsAppSendErrorMessage({ response: { data: { code: 'WHATSAPP_NOT_CONNECTED' } } }),
    ).toMatch(/not connected/i);
    expect(whatsAppSendErrorMessage({ response: { data: { error: 'boom' } } })).toBe('boom');
  });
});
