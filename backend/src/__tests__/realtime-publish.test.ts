import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Hoist mocks so vi.mock factory can reference them ───────────────────
const { mockSend, mockUnsubscribe, mockChannel, mockRemoveChannel } = vi.hoisted(() => {
  const mockSend = vi.fn().mockResolvedValue({});
  const mockUnsubscribe = vi.fn();
  const mockChannel = vi.fn(() => ({ send: mockSend, unsubscribe: mockUnsubscribe }));
  const mockRemoveChannel = vi.fn();
  return { mockSend, mockUnsubscribe, mockChannel, mockRemoveChannel };
});

vi.mock('../lib/supabase', () => ({
  supabaseAdmin: {
    channel: mockChannel,
    removeChannel: mockRemoveChannel,
  },
}));

// ─── Import AFTER mock is set up ─────────────────────────────────────────
import { publishNotificationsChanged } from '../services/notifications/realtimePublish';

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({});
});

const ORG_ID = 'org-aaaa-0000-0000-000000000001';
const USER_A = 'user-aaaa-0000-0000-000000000001';
const USER_B = 'user-bbbb-0000-0000-000000000002';

describe('publishNotificationsChanged', () => {
  it('creates one channel per recipient with the correct topic and private:true', async () => {
    await publishNotificationsChanged([USER_A, USER_B], ORG_ID);

    expect(mockChannel).toHaveBeenCalledTimes(2);
    expect(mockChannel).toHaveBeenCalledWith(
      `org:${ORG_ID}:user:${USER_A}`,
      { config: { private: true } },
    );
    expect(mockChannel).toHaveBeenCalledWith(
      `org:${ORG_ID}:user:${USER_B}`,
      { config: { private: true } },
    );
  });

  it('sends the correct broadcast event + payload for each recipient', async () => {
    await publishNotificationsChanged([USER_A, USER_B], ORG_ID);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledWith({
      type: 'broadcast',
      event: 'notifications.changed',
      payload: { type: 'notifications.changed' },
    });
  });

  it('cleans up each channel after send', async () => {
    const fakeChannel = { send: mockSend, unsubscribe: mockUnsubscribe };
    mockChannel.mockReturnValue(fakeChannel);

    await publishNotificationsChanged([USER_A], ORG_ID);

    expect(mockRemoveChannel).toHaveBeenCalledTimes(1);
    expect(mockRemoveChannel).toHaveBeenCalledWith(fakeChannel);
  });

  it('resolves void even when send rejects for one recipient, and still publishes the other', async () => {
    // First call rejects, second succeeds
    mockSend
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({});

    await expect(publishNotificationsChanged([USER_A, USER_B], ORG_ID)).resolves.toBeUndefined();

    // Both channels were still attempted
    expect(mockChannel).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledTimes(2);
    // removeChannel must be called for BOTH recipients — including the one whose send failed
    expect(mockRemoveChannel).toHaveBeenCalledTimes(2);
  });

  it('resolves void for an empty recipient list', async () => {
    await expect(publishNotificationsChanged([], ORG_ID)).resolves.toBeUndefined();
    expect(mockChannel).not.toHaveBeenCalled();
  });

  it('never references supabaseAdmin.auth', async () => {
    // The mock has no .auth property — if the impl tried to call it, it would throw.
    // Just confirm the function resolves cleanly.
    await expect(publishNotificationsChanged([USER_A], ORG_ID)).resolves.toBeUndefined();
  });
});
