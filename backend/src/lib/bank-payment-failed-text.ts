/**
 * The words of the "your bank payment didn't go through" message, in ONE place: the automatic email to the customer
 * (lib/email.ts) and the prefilled body of the office's Contact customer (services/payment-attention) both read it, so
 * the two cannot drift. Pure, and it does not import the mail client.
 */
const usd = (amount: number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

/** "Hi {name}, your bank payment of {amount} for invoice {INV} didn't go through." plus " Pay again here: {url}" when there is a link. */
export function bankPaymentFailedSentence(p: { customerName: string; amount: number; invoiceNumber: string; payUrl?: string | null }): string {
  return `Hi ${p.customerName}, your bank payment of ${usd(p.amount)} for invoice ${p.invoiceNumber} didn't go through.${p.payUrl ? ` Pay again here: ${p.payUrl}` : ''}`;
}

/** The subject the office's compose window opens with (the automatic email keeps its own, capitalised subject). */
export function bankPaymentFailedComposeSubject(invoiceNumber: string): string {
  return `Bank payment failed - Invoice ${invoiceNumber}`;
}

/**
 * The name the customer is greeted by: first and last name, else company, else "Customer". The automatic email
 * (checkout-effects `noticeCustomer`) and the office's prefilled email (payment-attention `items.ts`) both use it, so
 * the two never greet the same customer differently.
 */
export function greetingNameOf(customer: { first_name?: string | null; last_name?: string | null; company_name?: string | null }): string {
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.company_name || 'Customer';
}
