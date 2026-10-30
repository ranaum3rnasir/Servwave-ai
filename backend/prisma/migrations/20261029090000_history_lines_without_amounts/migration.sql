-- Roles & Permissions security, M4 follow-up (ticket 35), M16: old system-written money history lines lose their amounts.
--
-- Ran ruled (2026-10-28 / 29): a history line and a bell name NO figure in their words, to anyone, and no text is ever scanned.
-- The writers were changed (round 2). Rows written before that still carry the figure in their words, and the scan that used to
-- hide it for a person without See prices is gone. This migration rewrites those OLD rows to the amount-free wording the writers
-- use now. DATA ONLY, no schema change.
--
-- WHAT IT TOUCHES, and nothing else:
--   * timeline_events (a record's history, and a job's money lines, which are timeline events on the JOB): only rows whose
--     event_type is one a SYSTEM writer stores and whose description has EXACTLY the shape that writer produced, e.g. event
--     PAYMENT_RECEIVED with "Payment of $12.50 received via Cash". Every rule names its event type and anchors the whole text.
--     A note, a comment, a message or any text a person typed has another event type, or does not have the shape: it is never
--     matched, even when it says "$500".
--   * notifications (the bell): only the title/body of billing.* verbs and estimate.approved / estimate.deposit_paid, only the
--     leading "Amount: $X" / "Balance due: $X" shapes the templates produced. Message previews are not touched.
--
-- NO MONEY IS LOST. Before a figure is taken out of the words it is kept on the row, behind See prices:
--   * timeline_events.metadata gets "amount" (the parsed figure) when the row has neither "amount" nor the key that already holds
--     the same money (owed_amount, overpaid, amount_cents, disputed_cents); the second figure of a line (a tip, the balance still
--     due) goes to "tip_amount" / "amount_due" when absent. All three are keys the history route leaves out without See prices.
--   * notifications.data keeps its "amount" (stored by the writers), and gets it from the parsed figure when it is missing; the
--     bell route leaves it out for everyone.
--
-- IDEMPOTENT: after one run no row has the old shape, so a second run changes nothing. SET-BASED per rule. Portable plain
-- PostgreSQL. No timestamp is written. NEVER run `prisma migrate` from a worktree.

DO $m16$
DECLARE
  r record;
BEGIN
  -- The tables carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would read and write nothing.
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('statement_timeout', '0', true);
  -- Never queue behind a long writer: give up after 5 seconds instead (a failed run changes nothing).
  PERFORM set_config('lock_timeout', '5s', true);

  CREATE TEMP TABLE m16_rule (
    rule_no int PRIMARY KEY, rule_id text NOT NULL, entity_type text, event_types text[] NOT NULL, pat text NOT NULL, repl text NOT NULL,
    amount_group int NOT NULL, extra_key text, extra_group int, equiv text[] NOT NULL
  ) ON COMMIT DROP;
  INSERT INTO m16_rule VALUES
    (1, 'payment-received-with-tip', 'INVOICE', ARRAY['PAYMENT_RECEIVED']::text[], '^Payment of \$([0-9,]+\.[0-9]{2}) received via (.+) \(plus \$([0-9,]+\.[0-9]{2}) tip\)$', 'Payment received via \2 (plus a tip)', 1, 'tip_amount', 3, ARRAY['amount']::text[]),
    (2, 'payment-received', 'INVOICE', ARRAY['PAYMENT_RECEIVED']::text[], '^Payment of \$([0-9,]+\.[0-9]{2}) received via (.+)$', 'Payment received via \2', 1, NULL, NULL, ARRAY['amount']::text[]),
    (3, 'payment-received-online', 'INVOICE', ARRAY['PAYMENT_RECEIVED']::text[], '^(.+) of \$([0-9,]+\.[0-9]{2}) received (online|via ServWave Payments)$', '\1 received \3', 2, NULL, NULL, ARRAY['amount']::text[]),
    (4, 'payment-received-vendor-word', 'INVOICE', ARRAY['PAYMENT_RECEIVED']::text[], '^(.+) of \$([0-9,]+\.[0-9]{2}) received via Stripe$', '\1 received via ServWave Payments', 2, NULL, NULL, ARRAY['amount']::text[]),
    (5, 'bank-payment-cleared', 'INVOICE', ARRAY['PAYMENT_RECEIVED']::text[], '^Bank payment of \$([0-9,]+\.[0-9]{2}) cleared$', 'Bank payment cleared', 1, NULL, NULL, ARRAY['amount']::text[]),
    (6, 'payment-processing', 'INVOICE', ARRAY['PAYMENT_PROCESSING']::text[], '^(.+) of \$([0-9,]+\.[0-9]{2}) started; it takes a few business days to clear$', '\1 started; it takes a few business days to clear', 2, NULL, NULL, ARRAY['amount']::text[]),
    (7, 'payment-failed', 'INVOICE', ARRAY['PAYMENT_FAILED']::text[], '^(.+) of \$([0-9,]+\.[0-9]{2}) failed; nothing was collected$', '\1 failed; nothing was collected', 2, NULL, NULL, ARRAY['amount']::text[]),
    (8, 'bank-payment-failed', 'INVOICE', ARRAY['PAYMENT_FAILED']::text[], '^Bank payment of \$([0-9,]+\.[0-9]{2}) failed; the balance is open for payment again$', 'Bank payment failed; the balance is open for payment again', 1, NULL, NULL, ARRAY['amount']::text[]),
    (9, 'invoice-refunded', 'INVOICE', ARRAY['INVOICE_REFUNDED']::text[], '^Invoice (.+) refunded \$([0-9,]+\.[0-9]{2}) \((.+)\)$', 'Invoice \1 refunded (\3)', 2, NULL, NULL, ARRAY['amount']::text[]),
    (10, 'give-back-refund-reopened', 'INVOICE', ARRAY['INVOICE_REFUNDED']::text[], '^Invoice (.+) give-back refund \$([0-9,]+\.[0-9]{2}) - balance reopened to \$([0-9,]+\.[0-9]{2})$', 'Invoice \1 give-back refund - balance reopened', 2, 'amount_due', 3, ARRAY['amount']::text[]),
    (11, 'give-back-refund', 'INVOICE', ARRAY['INVOICE_REFUNDED']::text[], '^Invoice (.+) give-back refund \$([0-9,]+\.[0-9]{2})$', 'Invoice \1 give-back refund', 2, NULL, NULL, ARRAY['amount']::text[]),
    (12, 'refund-outside', 'INVOICE', ARRAY['INVOICE_REFUNDED']::text[], '^Refund of \$([0-9,]+\.[0-9]{2}) made outside ServWave recorded$', 'Refund made outside ServWave recorded', 1, NULL, NULL, ARRAY['amount']::text[]),
    (13, 'refund-recorded-attention', 'INVOICE', ARRAY['INVOICE_REFUNDED']::text[], '^Refund of \$([0-9,]+\.[0-9]{2}) recorded on this invoice by (.+)$', 'Refund recorded on this invoice by \2', 1, NULL, NULL, ARRAY['amount']::text[]),
    (14, 'invoice-refunded-dashboard', 'INVOICE', ARRAY['INVOICE_REFUNDED']::text[], '^Invoice refunded \$([0-9,]+\.[0-9]{2}) via Stripe dashboard$', 'Invoice refunded outside ServWave', 1, NULL, NULL, ARRAY['amount']::text[]),
    (15, 'deposit-refunded-dashboard', 'ESTIMATE', ARRAY['DEPOSIT_REFUNDED']::text[], '^Deposit refunded \$([0-9,]+\.[0-9]{2}) via Stripe dashboard$', 'Deposit refunded outside ServWave', 1, NULL, NULL, ARRAY['amount']::text[]),
    (16, 'credit-applied', 'INVOICE', ARRAY['CREDIT_APPLIED']::text[], '^Credit of \$([0-9,]+\.[0-9]{2}) applied to invoice (.+)$', 'Credit applied to invoice \2', 1, NULL, NULL, ARRAY['amount']::text[]),
    (17, 'write-off-credit', 'INVOICE', ARRAY['CREDIT_APPLIED']::text[], '^Write-off credit of \$([0-9,]+\.[0-9]{2}) recorded for the cash give-back on invoice (.+)$', 'Write-off credit recorded for the cash give-back on invoice \2', 1, NULL, NULL, ARRAY['amount']::text[]),
    (18, 'deposit-credit-reversed-chargeback', 'INVOICE', ARRAY['DEPOSIT_CREDIT_REVERSED']::text[], '^Deposit credit of \$([0-9,]+\.[0-9]{2}) reversed on invoice (.+) \(chargeback\)$', 'Deposit credit reversed on invoice \2 (chargeback)', 1, NULL, NULL, ARRAY['amount']::text[]),
    (19, 'deposit-credit-reversed', 'INVOICE', ARRAY['DEPOSIT_CREDIT_REVERSED']::text[], '^Deposit credit of \$([0-9,]+\.[0-9]{2}) reversed on invoice (.+)$', 'Deposit credit reversed on invoice \2', 1, NULL, NULL, ARRAY['amount']::text[]),
    (20, 'deposit-paid-via', 'ESTIMATE', ARRAY['DEPOSIT_PAID']::text[], '^Deposit of \$([0-9,]+\.[0-9]{2}) paid via (.+) for estimate (.+)$', 'Deposit paid via \2 for estimate \3', 1, NULL, NULL, ARRAY['amount']::text[]),
    (21, 'deposit-paid-bank', 'ESTIMATE', ARRAY['DEPOSIT_PAID']::text[], '^Deposit of \$([0-9,]+\.[0-9]{2}) paid by bank payment for estimate (.+)$', 'Deposit paid by bank payment for estimate \2', 1, NULL, NULL, ARRAY['amount']::text[]),
    (22, 'deposit-recorded-partial', 'ESTIMATE', ARRAY['DEPOSIT_PAID']::text[], '^Deposit of \$([0-9,]+\.[0-9]{2}) recorded via (.+) for estimate (.+) \(partial — \$([0-9,]+\.[0-9]{2}) remaining\)$', 'Deposit recorded via \2 for estimate \3 (partial)', 1, 'amount_due', 4, ARRAY['amount']::text[]),
    (23, 'deposit-recorded', 'ESTIMATE', ARRAY['DEPOSIT_PAID']::text[], '^Deposit of \$([0-9,]+\.[0-9]{2}) recorded via (.+) for estimate (.+)$', 'Deposit recorded via \2 for estimate \3', 1, NULL, NULL, ARRAY['amount']::text[]),
    (24, 'deposit-bank-started', 'ESTIMATE', ARRAY['DEPOSIT_PROCESSING']::text[], '^Deposit of \$([0-9,]+\.[0-9]{2}) by bank payment started for estimate (.+); it takes a few business days to clear$', 'Deposit by bank payment started for estimate \2; it takes a few business days to clear', 1, NULL, NULL, ARRAY['amount']::text[]),
    (25, 'deposit-requested-percent', 'ESTIMATE', ARRAY['DEPOSIT_REQUESTED']::text[], '^Deposit of \$([0-9,]+\.[0-9]{2}) requested \(([0-9.]+)%\)$', 'Deposit requested (\2%)', 1, NULL, NULL, ARRAY['amount']::text[]),
    (26, 'deposit-requested', 'ESTIMATE', ARRAY['DEPOSIT_REQUESTED']::text[], '^Deposit of \$([0-9,]+\.[0-9]{2}) requested$', 'Deposit requested', 1, NULL, NULL, ARRAY['amount']::text[]),
    (27, 'bank-return-chargeback', 'INVOICE', ARRAY['CHARGEBACK']::text[], '^The bank returned the payment of \$([0-9,]+\.[0-9]{2}) on invoice (.+); payment voided, (.+)$', 'The bank returned the payment on invoice \2; payment voided, \3', 1, NULL, NULL, ARRAY['amount']::text[]),
    (28, 'chargeback-lost', 'INVOICE', ARRAY['CHARGEBACK']::text[], '^Chargeback lost — payment of \$([0-9,]+\.[0-9]{2}) voided on invoice (.+); (.+)$', 'Chargeback lost — payment voided on invoice \2; \3', 1, NULL, NULL, ARRAY['amount']::text[]),
    (29, 'payment-voided', 'INVOICE', ARRAY['PAYMENT_VOIDED']::text[], '^Payment of \$([0-9,]+\.[0-9]{2}) voided on invoice (.+) \((.+)\)$', 'Payment voided on invoice \2 (\3)', 1, NULL, NULL, ARRAY['amount']::text[]),
    (30, 'bank-payment-canceled', 'INVOICE', ARRAY['PAYMENT_CANCELED']::text[], '^Bank payment of \$([0-9,]+\.[0-9]{2}) canceled before it cleared$', 'Bank payment canceled before it cleared', 1, NULL, NULL, ARRAY['amount']::text[]),
    (31, 'overpayment-flagged', 'INVOICE', ARRAY['OVERPAYMENT_FLAGGED']::text[], '^Overpayment of \$([0-9,]+\.[0-9]{2}) received on invoice (.+) — refund the excess$', 'Overpayment received on invoice \2 — refund the excess', 1, NULL, NULL, ARRAY['amount', 'overpaid']::text[]),
    (32, 'dispute-bank-return', 'INVOICE', ARRAY['INVOICE_DISPUTED']::text[], '^The bank returned the payment of \$([0-9,]+\.[0-9]{2}) on invoice (.+)$', 'The bank returned the payment on invoice \2', 1, NULL, NULL, ARRAY['amount']::text[]),
    (33, 'dispute-card', 'INVOICE', ARRAY['INVOICE_DISPUTED']::text[], '^Card payment of \$([0-9,]+\.[0-9]{2}) disputed on invoice (.+)$', 'Card payment disputed on invoice \2', 1, NULL, NULL, ARRAY['amount']::text[]),
    (34, 'chargeback-partial', 'INVOICE', ARRAY['CHARGEBACK_PARTIAL']::text[], '^(The bank returned|A lost dispute took back) \$([0-9,]+\.[0-9]{2}) of the \$[0-9,]+\.[0-9]{2} payment on invoice (.+)\. (The payment and the balance were left as they are; the balance needs a manual review\.)$', '\1 part of the payment on invoice \3. \4', 2, NULL, NULL, ARRAY['amount', 'disputed_cents']::text[]),
    (35, 'payment-returned', 'INVOICE', ARRAY['PAYMENT_RETURNED']::text[], '^(The bank returned the payment|A lost dispute took back the payment) of \$([0-9,]+\.[0-9]{2}) on invoice (.+) before it cleared\. (The payment was marked failed; it was never counted, so the balance is unchanged\.)$', '\1 on invoice \3 before it cleared. \4', 2, NULL, NULL, ARRAY['amount']::text[]),
    (36, 'unrecorded-bank-return', NULL, ARRAY['DISPUTE_ON_UNRECORDED_PAYMENT']::text[], '^The bank returned a payment of \$([0-9,]+\.[0-9]{2}) (on invoice .+|in this account) that was not recorded automatically\. (.*)$', 'The bank returned a payment \2 that was not recorded automatically. \3', 1, NULL, NULL, ARRAY['amount', 'amount_cents']::text[]),
    (37, 'unrecorded-card-dispute', NULL, ARRAY['DISPUTE_ON_UNRECORDED_PAYMENT']::text[], '^A customer disputed a card payment of \$([0-9,]+\.[0-9]{2}) (on invoice .+|in this account) that was not recorded on the invoice\. (.*)$', 'A customer disputed a card payment \2 that was not recorded on the invoice. \3', 1, NULL, NULL, ARRAY['amount', 'amount_cents']::text[]),
    (38, 'unapplied-not-payable', NULL, ARRAY['PAYMENT_UNRECORDED']::text[], '^(.+) of \$([0-9,]+\.[0-9]{2}) on invoice (.+) was not applied: the invoice was closed for payment \(voided or already paid\) while the payment was clearing\.$', '\1 on invoice \3 was not applied: the invoice was closed for payment (voided or already paid) while the payment was clearing.', 2, NULL, NULL, ARRAY['amount', 'charged_cents', 'unapplied_cents']::text[]),
    (39, 'unapplied-overpayment', NULL, ARRAY['PAYMENT_UNRECORDED']::text[], '^(.+) of \$([0-9,]+\.[0-9]{2}) on invoice (.+) was more than the balance due: \$[0-9,]+\.[0-9]{2} was not applied to the invoice\.$', '\1 on invoice \3 was more than the balance due: the excess was not applied to the invoice.', 2, NULL, NULL, ARRAY['amount', 'charged_cents', 'unapplied_cents']::text[]),
    (40, 'unapplied-no-invoice', NULL, ARRAY['PAYMENT_UNRECORDED']::text[], '^(.+) of \$([0-9,]+\.[0-9]{2}) was not recorded: it does not belong to any invoice in this account\.$', '\1 was not recorded: it does not belong to any invoice in this account.', 2, NULL, NULL, ARRAY['amount', 'charged_cents', 'unapplied_cents']::text[]),
    (41, 'unapplied-refund-unmatched', NULL, ARRAY['PAYMENT_UNRECORDED']::text[], '^(.+) of \$([0-9,]+\.[0-9]{2}) sent from this account was not recorded: it does not match any payment ServWave recorded\.$', '\1 sent from this account was not recorded: it does not match any payment ServWave recorded.', 2, NULL, NULL, ARRAY['amount', 'charged_cents', 'unapplied_cents']::text[]),
    (42, 'sent-back', 'INVOICE', ARRAY['PAYMENT_SENT_BACK']::text[], '^\$([0-9,]+\.[0-9]{2}) that could not be recorded on this invoice was sent back to the customer$', 'A payment that could not be recorded on this invoice was sent back to the customer', 1, NULL, NULL, ARRAY['amount']::text[]),
    (43, 'payment-attached', 'INVOICE', ARRAY['PAYMENT_ATTACHED']::text[], '^Payment of \$([0-9,]+\.[0-9]{2}) from payments needing attention (recorded on the new invoice|attached to) (.+) by (.+)$', 'Payment from payments needing attention \2 \3 by \4', 1, NULL, NULL, ARRAY['amount']::text[]),
    (44, 'job-marked-done-owed', 'JOB', ARRAY['JOB_MARKED_DONE']::text[], '^Job (.+) marked Done with \$([0-9,]+\.[0-9]{2}) still owed$', 'Job \1 marked Done with money still owed', 2, NULL, NULL, ARRAY['amount', 'owed_amount']::text[]),
    (45, 'job-money-online', 'JOB', ARRAY['JOB_PAYMENT_RECORDED', 'JOB_DEPOSIT_APPLIED', 'JOB_REFUND_ISSUED', 'JOB_PAYMENT_VOIDED']::text[], '^Invoice (.+) (payment recorded|deposit applied|refund issued|payment voided): \$([0-9,]+\.[0-9]{2}) received via ServWave Payments$', 'Invoice \1 \2 via ServWave Payments', 3, NULL, NULL, ARRAY['amount']::text[]),
    (46, 'job-money', 'JOB', ARRAY['JOB_PAYMENT_RECORDED', 'JOB_DEPOSIT_APPLIED', 'JOB_REFUND_ISSUED', 'JOB_PAYMENT_VOIDED']::text[], '^Invoice (.+) (payment recorded|deposit applied|refund issued|payment voided): \$([0-9,]+\.[0-9]{2})( via .+)?$', 'Invoice \1 \2\4', 3, NULL, NULL, ARRAY['amount']::text[]);

  FOR r IN SELECT * FROM m16_rule ORDER BY rule_no LOOP
    UPDATE timeline_events t
       SET description = regexp_replace(t.description, r.pat, r.repl),
           metadata =
             (CASE WHEN jsonb_typeof(t.metadata) = 'object' THEN t.metadata ELSE '{}'::jsonb END)
             || CASE WHEN COALESCE(t.metadata ?| r.equiv, false) THEN '{}'::jsonb
                     ELSE jsonb_build_object('amount', replace((regexp_match(t.description, r.pat))[r.amount_group], ',', '')::numeric) END
             || CASE WHEN r.extra_key IS NULL OR COALESCE(t.metadata ? r.extra_key, false) THEN '{}'::jsonb
                     ELSE jsonb_build_object(r.extra_key, replace((regexp_match(t.description, r.pat))[r.extra_group], ',', '')::numeric) END
     WHERE t.event_type = ANY (r.event_types)
       AND (r.entity_type IS NULL OR t.entity_type = r.entity_type)
       AND t.description ~ r.pat;
  END LOOP;

  CREATE TEMP TABLE m16_bell (rule_no int PRIMARY KEY, rule_id text NOT NULL, pat text NOT NULL, repl text) ON COMMIT DROP;
  INSERT INTO m16_bell VALUES
    (1, 'bell-body-only-amount', '^(Amount|Balance due): \$[0-9,]+(\.[0-9]+)?\.?$', NULL),
    (2, 'bell-body-amount-then-why', '^(Amount|Balance due): \$[0-9,]+(\.[0-9]+)?\.?\n', ''),
    (3, 'bell-body-amount-sentence', '^Amount: \$[0-9,]+(\.[0-9]+)?\. ', ''),
    (4, 'bell-body-amount-options', '^Amount: \$[0-9,]+(\.[0-9]+)? · ', ''),
    (5, 'bell-body-taken-back', '^Amount: \$[0-9,]+(\.[0-9]+)? was taken back from your ServWave Payments balance\.', 'This payment was taken back from your ServWave Payments balance.'),
    (6, 'bell-body-bank-took-back', '^The bank took back \$[0-9,]+(\.[0-9]+)?\.', 'The bank took back this payment.'),
    (7, 'bell-body-partial-chargeback', '^\$[0-9,]+(\.[0-9]+)? was taken back\. The payment was left', 'Part of this payment was taken back. The payment was left'),
    (8, 'bell-body-refund-failed', '^(A bank refund|A refund) of \$[0-9,]+(\.[0-9]+)? to ', '\1 to ');

  FOR r IN SELECT * FROM m16_bell ORDER BY rule_no LOOP
    -- The figure is read from the old body before it is rewritten, and kept on the bell's data when that has none.
    UPDATE notifications n
       SET data = CASE
                    WHEN jsonb_typeof(n.data) = 'object' AND NOT (n.data ? 'amount') AND substring(n.body from '[0-9][0-9,]*(?:\.[0-9]+)?') IS NOT NULL
                      THEN n.data || jsonb_build_object('amount', replace(substring(n.body from '[0-9][0-9,]*(?:\.[0-9]+)?'), ',', ''))
                    ELSE n.data END,
           body = NULLIF(regexp_replace(n.body, r.pat, COALESCE(r.repl, '')), '')
     WHERE (n.verb LIKE 'billing.%' OR n.verb IN ('estimate.approved', 'estimate.deposit_paid'))
       AND n.body ~ r.pat;
  END LOOP;

  -- The first-payment nudge names the amount in its title and on the first line of its body; the line under it (why it reached this person) stays.
  UPDATE notifications n
     SET data = CASE
                  WHEN jsonb_typeof(n.data) = 'object' AND NOT (n.data ? 'amount') AND substring(n.title from '\$([0-9][0-9,]*(?:\.[0-9]+)?)') IS NOT NULL
                    THEN n.data || jsonb_build_object('amount', replace(substring(n.title from '\$([0-9][0-9,]*(?:\.[0-9]+)?)'), ',', ''))
                  ELSE n.data END,
         title = regexp_replace(n.title, '^You''ve collected \$[0-9,]+(\.[0-9]+)?\. ', 'You''ve collected a payment. '),
         body = CASE WHEN n.body ~ '^\$[0-9,]+(\.[0-9]+)?$' THEN NULL
                     WHEN n.body ~ '^\$[0-9,]+(\.[0-9]+)?\n' THEN regexp_replace(n.body, '^\$[0-9,]+(\.[0-9]+)?\n', '')
                     ELSE n.body END
   WHERE n.verb = 'billing.payouts_pending_first_payment'
     AND n.title ~ '^You''ve collected \$[0-9,]+(\.[0-9]+)?\. (Add your bank account|Connect your bank) to get paid out\.$';
END
$m16$;
