import { test, expect } from '@playwright/test';
import { ApiClient, FIXTURES_DIR } from '../helpers/api-client';
import { fullStandardFlow } from '../helpers/workflow-builders';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

let api: ApiClient;
let jobId: string;

test.beforeAll(async () => {
  api = await new ApiClient().init();
  // Create a job to use across most tests
  const flow = await fullStandardFlow(api);
  jobId = flow.jobId;
});

test.afterAll(async () => {
  await api.dispose();
});

// ─── Happy-path uploads ─────────────────────────────────

test('upload attachment to a job', async () => {
  const { res, body } = await api.uploadAttachment('JOB', jobId, {
    file: 'test-photo.jpg',
    display_name: 'Front view of unit',
    description: 'HVAC unit exterior showing model plate',
    context: 'JOB_WORK',
  });

  expect(res.status()).toBe(200);
  const att = body.attachment;
  expect(att.display_name).toBe('Front view of unit');
  expect(att.description).toBe('HVAC unit exterior showing model plate');
  expect(att.context).toBe('JOB_WORK');
  expect(att.file_type).toBe('image/jpeg');
  expect(att.id).toBeTruthy();
});

test('upload PNG attachment', async () => {
  const { res, body } = await api.uploadAttachment('JOB', jobId, {
    file: 'test-image.png',
    display_name: 'Thermostat screenshot',
    description: 'Temperature reading at time of inspection',
    context: 'OTHER',
  });

  expect(res.status()).toBe(200);
  expect(body.attachment.file_type).toBe('image/png');
});

test('upload PDF attachment', async () => {
  const { res, body } = await api.uploadAttachment('JOB', jobId, {
    file: 'test-document.pdf',
    display_name: 'Permit document',
    description: 'Electrical permit for panel upgrade',
    context: 'OTHER',
  });

  expect(res.status()).toBe(200);
  expect(body.attachment.file_type).toBe('application/pdf');
});

// ─── List & delete ──────────────────────────────────────

test('list attachments for entity', async () => {
  // Upload 2 files to a fresh count context — use distinct display names
  const suffix = api.suffix;
  await api.uploadAttachment('JOB', jobId, {
    file: 'test-photo.jpg',
    display_name: `List-test-A-${suffix}`,
    description: 'First file for list test',
    context: 'JOB_WORK',
  });
  await api.uploadAttachment('JOB', jobId, {
    file: 'test-image.png',
    display_name: `List-test-B-${suffix}`,
    description: 'Second file for list test',
    context: 'JOB_WORK',
  });

  const { res, body } = await api.listAttachments('JOB', jobId);
  expect(res.status()).toBe(200);

  // Filter to just this test's uploads
  const ours = body.attachments.filter(
    (a: any) => a.display_name.startsWith(`List-test-`) && a.display_name.includes(suffix),
  );
  expect(ours).toHaveLength(2);
  const names = ours.map((a: any) => a.display_name).sort();
  expect(names[0]).toBe(`List-test-A-${suffix}`);
  expect(names[1]).toBe(`List-test-B-${suffix}`);
});

test('delete attachment', async () => {
  // Upload a file, then delete it
  const { body: uploadBody } = await api.uploadAttachment('JOB', jobId, {
    file: 'test-photo.jpg',
    display_name: `Delete-test-${api.suffix}`,
    description: 'Will be deleted',
    context: 'OTHER',
  });
  const attId = uploadBody.attachment.id;

  const { status } = await api.deleteAttachment('JOB', jobId, attId);
  expect(status).toBe(200);

  // Verify it no longer appears in the list
  const { body: listBody } = await api.listAttachments('JOB', jobId);
  const found = listBody.attachments.find((a: any) => a.id === attId);
  expect(found).toBeUndefined();
});

// ─── Context variations ─────────────────────────────────

test('upload with all contexts', async () => {
  const contexts = ['WALKTHROUGH', 'JOB_WORK', 'ESTIMATE', 'OTHER'] as const;
  const suffix = api.suffix;
  const ids: string[] = [];

  for (const ctx of contexts) {
    const { body } = await api.uploadAttachment('JOB', jobId, {
      file: 'test-photo.jpg',
      display_name: `Ctx-${ctx}-${suffix}`,
      description: `Testing context ${ctx}`,
      context: ctx,
    });
    ids.push(body.attachment.id);
  }

  const { body: listBody } = await api.listAttachments('JOB', jobId);
  for (let i = 0; i < contexts.length; i++) {
    const att = listBody.attachments.find((a: any) => a.id === ids[i]);
    expect(att).toBeDefined();
    expect(att.context).toBe(contexts[i]);
  }
});

// ─── Validation / negative tests ────────────────────────

test('requires display_name', async () => {
  const filePath = path.join(FIXTURES_DIR, 'test-photo.jpg');
  const buffer = fs.readFileSync(filePath);

  const res = await (api as any).ctx.post(`/api/attachments/JOB/${jobId}`, {
    multipart: {
      file: { name: 'test-photo.jpg', mimeType: 'image/jpeg', buffer },
      description: 'Has description but no display name',
      context: 'OTHER',
    },
  });

  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error).toContain('display_name');
});

test('requires description', async () => {
  const filePath = path.join(FIXTURES_DIR, 'test-photo.jpg');
  const buffer = fs.readFileSync(filePath);

  const res = await (api as any).ctx.post(`/api/attachments/JOB/${jobId}`, {
    multipart: {
      file: { name: 'test-photo.jpg', mimeType: 'image/jpeg', buffer },
      display_name: 'Has name but no description',
      context: 'OTHER',
    },
  });

  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error).toContain('description');
});

test('rejects invalid entity type', async () => {
  const filePath = path.join(FIXTURES_DIR, 'test-photo.jpg');
  const buffer = fs.readFileSync(filePath);

  const res = await (api as any).ctx.post(`/api/attachments/CUSTOMER/${jobId}`, {
    multipart: {
      file: { name: 'test-photo.jpg', mimeType: 'image/jpeg', buffer },
      display_name: 'Invalid entity test',
      description: 'Should fail with 400',
      context: 'OTHER',
    },
  });

  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error).toContain('entity type');
});

test('rejects non-existent entity', async () => {
  const fakeId = crypto.randomUUID();
  const filePath = path.join(FIXTURES_DIR, 'test-photo.jpg');
  const buffer = fs.readFileSync(filePath);

  const res = await (api as any).ctx.post(`/api/attachments/JOB/${fakeId}`, {
    multipart: {
      file: { name: 'test-photo.jpg', mimeType: 'image/jpeg', buffer },
      display_name: 'Non-existent entity test',
      description: 'Should fail with 404',
      context: 'OTHER',
    },
  });

  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.error).toContain('not found');
});
