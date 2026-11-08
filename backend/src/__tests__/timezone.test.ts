import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { prisma } from '../lib/prisma';
import { formatDateTimeInZone, getOrgTimezone, DEFAULT_TIMEZONE } from '../lib/timezone';

describe('formatDateTimeInZone', () => {
  // 2026-06-08T15:00:00Z is 11:00 AM in Eastern Daylight Time (UTC-4).
  const summerInstant = new Date('2026-06-08T15:00:00Z');
  // 2026-01-15T16:00:00Z is 11:00 AM in Eastern Standard Time (UTC-5).
  const winterInstant = new Date('2026-01-15T16:00:00Z');

  it('renders a UTC instant in the given timezone, not in UTC', () => {
    const out = formatDateTimeInZone(summerInstant, 'America/New_York');
    expect(out).toContain('11:00 AM'); // Eastern wall-clock
    expect(out).not.toContain('3:00 PM'); // would be the UTC rendering — the bug
    expect(out).toContain('June 8, 2026');
  });

  it('handles daylight-saving correctly (EST in winter is UTC-5)', () => {
    const out = formatDateTimeInZone(winterInstant, 'America/New_York');
    expect(out).toContain('11:00 AM');
    expect(out).not.toContain('4:00 PM'); // the UTC rendering
  });

  it('defaults to America/New_York when no timezone is passed', () => {
    expect(formatDateTimeInZone(summerInstant)).toBe(
      formatDateTimeInZone(summerInstant, 'America/New_York'),
    );
    expect(DEFAULT_TIMEZONE).toBe('America/New_York');
  });

  it('respects a non-Eastern timezone', () => {
    // 15:00Z is 8:00 AM Pacific Daylight Time (UTC-7)
    const out = formatDateTimeInZone(summerInstant, 'America/Los_Angeles');
    expect(out).toContain('8:00 AM');
  });
});

describe('getOrgTimezone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the organization's configured timezone", async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ timezone: 'America/Chicago' });
    await expect(getOrgTimezone('org-1')).resolves.toBe('America/Chicago');
  });

  it('falls back to the default when the org is missing', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue(null);
    await expect(getOrgTimezone('org-1')).resolves.toBe(DEFAULT_TIMEZONE);
  });

  it('falls back to the default when timezone is null', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ timezone: null });
    await expect(getOrgTimezone('org-1')).resolves.toBe(DEFAULT_TIMEZONE);
  });

  it('falls back to the default when the query throws', async () => {
    (prisma.organization.findUnique as Mock).mockRejectedValue(new Error('db down'));
    await expect(getOrgTimezone('org-1')).resolves.toBe(DEFAULT_TIMEZONE);
  });
});
