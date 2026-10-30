import type { ApiClient } from '../helpers/api-client';
import { uniquePhone } from '../helpers/workflow-builders';
import { gateCustomerEmail } from './gate-inbox';

/**
 * The address every customer the gate seeds is created with.
 *
 * Why not `@e2e-qa.invalid`: the "Payment Received" receipt ignores the organisation's outgoing-email
 * switch, so a gate run's throwaway org DOES send one receipt, to the customer it records a payment
 * for. A domain that cannot resolve (`.invalid`, `.test`, `.example`) makes that receipt bounce, and
 * bounces hurt the staging sending domain. The email provider's test inbox accepts mail and delivers
 * it nowhere, so a receipt sent to it is "delivered" and nothing bounces. A `+label` after
 * `delivered` is the provider's documented way to keep addresses distinct while they land in the
 * same sink, which the duplicate-customer guard needs.
 *
 * This is test data inside a throwaway org that is torn down, not product copy. It is built in
 * gate-inbox.ts (the label charset is checked there), and the copy check ignores exactly this address
 * and nothing else (`acceptedExceptions.gateTestInbox`, vendor-terms.ts).
 * src/__tests__/mobile-gate-receipt-inbox.test.ts holds the rule.
 */
export { gateCustomerEmail };

/**
 * The label for a customer seeded with run suffix `s`. It is kept short ON PURPOSE: the customers list and
 * the job page show the email in a truncating span, and the address is `delivered+<label>@resend.dev`,
 * which is 21 characters before the label. The first attempt used `gate-<full suffix>` (37 characters) and
 * the 320 px phone's `overflow` check measured that span 2 px past the screen edge on `customers` and
 * `job-detail`. `g-` plus the last 7 characters of the suffix is 30 characters, the length of the
 * `test-<suffix>@e2e-qa.invalid` address the gate used before and which fit. The tail of the suffix is the
 * millisecond clock plus three random characters, so two customers in one org never share it.
 */
export const gateCustomerLabel = (suffix: string) => `g-${suffix.slice(-7)}`;

/**
 * A customer with a primary service location, for the gate's seed and for a spec that needs a
 * record of its own. The shared `createCustomerWithLocation` (helpers/workflow-builders.ts) seeds a
 * `.invalid` address for the other suites; the gate does not use it.
 */
export async function gateCustomerWithLocation(api: ApiClient) {
  const s = api.suffix;
  const customer = await api.createCustomer({
    first_name: `Test-${s}`, last_name: 'Customer',
    email: gateCustomerEmail(gateCustomerLabel(s)), phone: uniquePhone(),
  });
  const location = await api.addLocation(customer.id, {
    address_line1: `${Math.floor(Math.random() * 9999)} Test St`,
    city: 'Austin', state: 'TX', zip: '78701', is_primary: true,
  });
  return { customerId: customer.id as string, locationId: location.id as string };
}
