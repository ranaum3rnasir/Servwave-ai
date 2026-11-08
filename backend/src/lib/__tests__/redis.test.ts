import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ioredis before importing the module under test so no real connection is
// attempted. The mock factory runs synchronously at module load time.
// ioredis's default export is a class — the mock must use 'function' (not an
// arrow) so vitest treats it as a constructor that can be called with `new`.
vi.mock('ioredis', () => {
  const onMock = vi.fn();
  // eslint-disable-next-line prefer-arrow-callback
  const RedisMock = vi.fn(function () {
    return { on: onMock };
  });
  return { default: RedisMock };
});

// Mock the logger so we can assert warn calls without console noise.
vi.mock('../logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Delay importing the module under test until the mocks are wired.
import Redis from 'ioredis';
import { logger } from '../logger';
import { createRedisClient } from '../redis';

const RedisMock = Redis as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createRedisClient', () => {
  it('returns null for undefined url and does NOT construct a Redis client', () => {
    const result = createRedisClient(undefined);
    expect(result).toBeNull();
    expect(RedisMock).not.toHaveBeenCalled();
  });

  it('returns null for empty string url and does NOT construct a Redis client', () => {
    const result = createRedisClient('');
    expect(result).toBeNull();
    expect(RedisMock).not.toHaveBeenCalled();
  });

  it('constructs a Redis client with the expected options when a valid URL is provided', () => {
    const url = 'redis://localhost:6379';
    const result = createRedisClient(url);

    expect(result).not.toBeNull();
    expect(RedisMock).toHaveBeenCalledOnce();
    expect(RedisMock).toHaveBeenCalledWith(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 10_000,
      lazyConnect: false,
    });
  });

  it("registers an 'error' listener on the client", () => {
    const url = 'redis://localhost:6379';
    createRedisClient(url);

    // The mock instance's `.on` should have been called with 'error'
    const instance = RedisMock.mock.results[0].value as { on: ReturnType<typeof vi.fn> };
    expect(instance.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it("'error' handler calls logger.warn and does NOT throw", () => {
    const url = 'redis://localhost:6379';
    createRedisClient(url);

    const instance = RedisMock.mock.results[0].value as { on: ReturnType<typeof vi.fn> };
    // Find the 'error' handler registered via .on('error', handler)
    const errorCall = (instance.on.mock.calls as [string, (...args: unknown[]) => void][]).find(
      ([event]) => event === 'error',
    );
    expect(errorCall).toBeDefined();

    const handler = errorCall![1];

    // Invoking the handler must not throw
    expect(() => handler(new Error('connection refused'))).not.toThrow();

    // And it must have called logger.warn
    expect(logger.warn).toHaveBeenCalled();
  });
});
