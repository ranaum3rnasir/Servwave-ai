import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import { createContactedLead } from '../../helpers/workflow-builders';

let api: ApiClient;

test.beforeAll(async () => {
  api = await new ApiClient().init();
});

test.afterAll(async () => {
  await api.dispose();
});

test('API health check', async () => {
  const { res } = await api.listLeads();
  expect(res.ok()).toBe(true);
});

test('can create a customer', async () => {
  const s = api.suffix;
  const customer = await api.createCustomer({
    first_name: `Smoke-${s}`, last_name: 'Test',
    email: `smoke-${s}@e2e.local`, phone: '5551234567',
  });
  expect(customer.id).toBeTruthy();
  expect(customer.first_name).toContain('Smoke');
});

test('workflow builder creates contacted lead', async () => {
  const { leadId } = await createContactedLead(api);
  const lead = await api.getLead(leadId);
  expect(lead.status).toBe('CONTACTED');
});
