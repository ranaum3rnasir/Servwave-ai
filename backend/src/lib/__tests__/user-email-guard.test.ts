import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../prisma';
import {
  assertEmailAvailable,
  EmailAlreadyRegisteredError,
  EMAIL_ALREADY_REGISTERED_MSG,
} from '../user-email-guard';

const mockFindFirst = prisma.user.findFirst as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assertEmailAvailable', () => {
  it('resolves without throwing when the email is not in use anywhere', async () => {
    mockFindFirst.mockResolvedValue(null);
    await expect(assertEmailAvailable('new@test.com')).resolves.toBeUndefined();
  });

  it('throws EmailAlreadyRegisteredError when a user with that email exists in ANY org', async () => {
    mockFindFirst.mockResolvedValue({ id: 'existing-user-id' });
    await expect(assertEmailAvailable('taken@test.com')).rejects.toThrow(EmailAlreadyRegisteredError);
  });

  it('carries the canonical message on the thrown error', async () => {
    mockFindFirst.mockResolvedValue({ id: 'existing-user-id' });
    await expect(assertEmailAvailable('taken@test.com')).rejects.toThrow(EMAIL_ALREADY_REGISTERED_MSG);
  });

  it('looks up case-insensitively and does NOT scope by organization_id', async () => {
    mockFindFirst.mockResolvedValue(null);
    await assertEmailAvailable('Mixed@Case.com');
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'Mixed@Case.com', mode: 'insensitive' } },
      select: { id: true },
    });
  });
});
