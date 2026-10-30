/**
 * Batch 70: the alert filter gained an import of the task-access modules, which read `prisma.job` while they LOADED.
 * Ten real-database test files mock '../lib/prisma' with a client that is undefined when TEST_DATABASE_URL is unset
 * (CI's Backend job has no database), so they crashed at import instead of skipping.
 *
 * Nothing the alert writer loads may read a model off the client at load time; the client is touched only inside
 * the functions that use it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/prisma', () => ({ prisma: undefined }));

describe('modules the alert writer loads, with no database client', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('loads the access filter', async () => {
    await expect(import('../services/notifications/filterByAccess.js')).resolves.toBeDefined();
  });

  it('loads the task entity access modules', async () => {
    await expect(import('../lib/tasks/entityAccess.js')).resolves.toBeDefined();
    await expect(import('../lib/tasks/entityAccessCohort.js')).resolves.toBeDefined();
  });

  it('loads the communication readers the access filter asks about calls, texts and email', async () => {
    await expect(import('../lib/communication/conversationReaders.js')).resolves.toBeDefined();
    await expect(import('../lib/communication/communicationScope.js')).resolves.toBeDefined();
  });

  it('loads the call and text alert lookup and its never-silent fallback (S08.24)', async () => {
    await expect(import('../services/notifications/conversationAlertRecipients.js')).resolves.toBeDefined();
    await expect(import('../services/notifications/conversationAlertFallback.js')).resolves.toBeDefined();
    await expect(import('../services/notifications/notificationService.js')).resolves.toBeDefined();
  });

  it('loads the realtime publisher', async () => {
    await expect(import('../services/notifications/realtimePublish.js')).resolves.toBeDefined();
  });
});
