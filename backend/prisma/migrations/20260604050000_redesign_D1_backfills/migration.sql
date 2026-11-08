-- ============================================================================
-- Entity-redesign Phase D — D1 DATA BACKFILLS (hand-authored, COMMITTED UNAPPLIED)
-- ============================================================================
--
-- STATUS: hand-authored, committed UNAPPLIED. Applied by the HUMAN during the
-- Phase-D cutover window (worktree .env = STAGING — never `prisma migrate` from a
-- worktree). See md_files/plans/entity-redesign/CUTOVER-RUNBOOK.md.
--
-- ORDER: D1 runs FIRST — it READS legacy data and WRITES the new shape, BEFORE any
-- NOT NULL tighten (D2) or DROP (D3). This ordering is constraint #7 of the plan:
-- a NOT NULL tighten that lands without its backfill crashes `migrate deploy` on
-- boot (the customer-number-prod-drift incident, memory/incident-customer-number-prod-drift.md).
--
-- ALL STEPS ARE IDEMPOTENT (find-or-create / WHERE ... IS NULL / NOT EXISTS guards),
-- so a partial/retried apply never double-inserts.
--
-- DEPENDS ON: the additive migrations (040000 _redesign_01_additive,
-- 040100 _redesign_02_enum_values) already applied — the new columns/tables/enum
-- values (kind, segment, customer_phones, invoices.estimate_id/customer_id/kind,
-- InvoiceKind, PARTIALLY_REFUNDED/DISPUTED) must already exist. The legacy columns
-- (deposits, job_charges, estimates.customer_id, customers.phone*/ad_source, leads.service_address_*)
-- still exist at D1 time — they are read here and dropped only in D3.

-- ─────────────────────────────────────────────────────────────────────────────
-- D1f — Customer kind / segment / source + customer_phones backfill
-- (runs early: many later joins/derivations are unaffected, and it is self-contained.)
-- READS the KEEP-deprecated columns (company_name, ad_source, phone*) which survive
-- this phase; populates the new required-by-app invariants.
-- ─────────────────────────────────────────────────────────────────────────────

-- kind: COMPANY when there is a company name and no person first-name; else PERSON.
-- segment: default RESIDENTIAL. source: carry from the legacy ad_source.
UPDATE customers
SET kind = CASE
             WHEN company_name IS NOT NULL AND COALESCE(first_name, '') = '' THEN 'COMPANY'::"CustomerKind"
             ELSE 'PERSON'::"CustomerKind"
           END,
    segment = COALESCE(segment, 'RESIDENTIAL'::"CustomerSegment"),
    source = COALESCE(source, ad_source)
WHERE kind IS NULL;

-- customer_phones: one primary row from (phone, phone_ext); a secondary from
-- (secondary_phone, secondary_phone_ext). Guard: only when the customer has NO phone row yet
-- (idempotent) and the source phone is non-empty.
INSERT INTO customer_phones (id, customer_id, phone, extension, is_primary, created_at)
SELECT gen_random_uuid(), c.id, c.phone, NULLIF(c.phone_ext, ''), true, NOW()
FROM customers c
WHERE COALESCE(c.phone, '') <> ''
  AND NOT EXISTS (SELECT 1 FROM customer_phones p WHERE p.customer_id = c.id);

INSERT INTO customer_phones (id, customer_id, phone, extension, is_primary, created_at)
SELECT gen_random_uuid(), c.id, c.secondary_phone, NULLIF(c.secondary_phone_ext, ''), false, NOW()
FROM customers c
WHERE COALESCE(c.secondary_phone, '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM customer_phones p
    WHERE p.customer_id = c.id AND p.phone = c.secondary_phone
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- D1c — Lead.service_location_id backfill from legacy service_address_*
-- Find-or-create a ServiceLocation on the lead's customer, deduping on the SAME
-- normalized rule as backend/src/lib/service-location.ts (the single source of truth):
--   normalized line1 = collapse-whitespace(lower(trim(address_line1)))
--   normalized zip   = strip-non-digits(zip)
-- Guard: WHERE service_location_id IS NULL AND service_address_line1 IS NOT NULL.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Create a ServiceLocation for any lead whose address has no matching location yet.
INSERT INTO service_locations (id, customer_id, address_line1, address_line2, city, state, zip, is_primary, is_active, created_at)
SELECT gen_random_uuid(), l.customer_id,
       l.service_address_line1, l.service_address_line2,
       COALESCE(l.service_city, ''), COALESCE(l.service_state, ''), COALESCE(l.service_zip, ''),
       false, true, NOW()
FROM leads l
WHERE l.service_location_id IS NULL
  AND l.service_address_line1 IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM service_locations s
    WHERE s.customer_id = l.customer_id
      AND regexp_replace(lower(trim(s.address_line1)), '\s+', ' ', 'g')
          = regexp_replace(lower(trim(l.service_address_line1)), '\s+', ' ', 'g')
      AND regexp_replace(COALESCE(s.zip, ''), '\D', '', 'g')
          = regexp_replace(COALESCE(l.service_zip, ''), '\D', '', 'g')
  );

-- 2) Point each lead at the matching (now-existing) ServiceLocation.
UPDATE leads l
SET service_location_id = s.id
FROM service_locations s
WHERE l.service_location_id IS NULL
  AND l.service_address_line1 IS NOT NULL
  AND s.customer_id = l.customer_id
  AND regexp_replace(lower(trim(s.address_line1)), '\s+', ' ', 'g')
      = regexp_replace(lower(trim(l.service_address_line1)), '\s+', ' ', 'g')
  AND regexp_replace(COALESCE(s.zip, ''), '\D', '', 'g')
      = regexp_replace(COALESCE(l.service_zip, ''), '\D', '', 'g');

-- 3) Fallback for any lead STILL NULL (no legacy address at all): anchor to the
-- customer's primary location if one exists. (Leads with neither an address nor any
-- customer location are reported by the Step-1 audit query and must be fixed by hand
-- BEFORE D2 tightens leads.service_location_id NOT NULL.)
UPDATE leads l
SET service_location_id = s.id
FROM service_locations s
WHERE l.service_location_id IS NULL
  AND s.customer_id = l.customer_id
  AND s.is_primary = true
  AND s.is_active = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- D1d — Estimate lead-less synthesis (Track-2 rows with lead_id IS NULL)
-- DECISION (documented in the runbook, Step-1 audit decides): SYNTHESIZE a Lead from
-- the surviving estimates.customer_id (+ a service_location resolved via the escalating
-- primary → any-active → synthesize-minimal fallback below, so the synthesized lead's
-- service_location_id is NEVER NULL and cannot crash D2's NOT NULL tighten) rather than
-- hard-block — a single lead-less row would otherwise
-- wedge the irreversible cutover, and the customer edge is recoverable. D1a additionally
-- keeps a COALESCE(...,estimates.customer_id) fallback as belt-and-suspenders.
-- MUST run BEFORE D1a so the deposit dissolution can resolve estimate → lead → customer.
-- Idempotent: only fires for estimates with lead_id IS NULL.
-- ─────────────────────────────────────────────────────────────────────────────

-- Synthesize one Lead per lead-less estimate, allocating the L##### number atomically
-- from the org sequence (MIRRORS backend/src/lib/numbering.ts — post-increment counter,
-- NEVER a parallel max+1; see incident-customer-number-prod-drift). A CTE-per-row loop is
-- not expressible in plain SQL, so we use a PL/pgSQL block.
DO $$
DECLARE
  est RECORD;
  alloc_next INT;
  alloc_prefix TEXT;
  alloc_padding INT;
  new_lead_id UUID;
  primary_loc UUID;
BEGIN
  FOR est IN
    SELECT e.id, e.customer_id, e.organization_id
    FROM estimates e
    WHERE e.lead_id IS NULL
  LOOP
    -- Atomic L-number allocation (row-locked UPDATE ... RETURNING; allocated = next-1).
    UPDATE organizations
    SET lead_next_number = lead_next_number + 1,
        lead_first_issued_at = COALESCE(lead_first_issued_at, NOW())
    WHERE id = est.organization_id
    RETURNING lead_next_number, lead_prefix, number_padding
    INTO alloc_next, alloc_prefix, alloc_padding;

    -- Pick a service location for the synthesized lead. leads.service_location_id is
    -- tightened NOT NULL by D2, so it MUST be non-NULL here — D1d is the only producer of
    -- these rows and D1c's fallback (which runs BEFORE D1d) never sees them, so there is no
    -- later safety net. Resolve in three escalating steps:
    --   (1) the customer's primary active location;
    --   (2) ANY active location for the customer (drop the is_primary filter);
    --   (3) synthesize a minimal ServiceLocation (mirrors D1c's find-or-create) so the
    --       synthesized lead is NEVER left with a NULL location.
    SELECT s.id INTO primary_loc
    FROM service_locations s
    WHERE s.customer_id = est.customer_id AND s.is_primary = true AND s.is_active = true
    LIMIT 1;

    IF primary_loc IS NULL THEN
      SELECT s.id INTO primary_loc
      FROM service_locations s
      WHERE s.customer_id = est.customer_id AND s.is_active = true
      ORDER BY s.created_at
      LIMIT 1;
    END IF;

    IF primary_loc IS NULL THEN
      -- Synthesize a minimal placeholder location for the customer. Marked non-primary so it
      -- never displaces a real primary later; the empty address mirrors D1c's tolerance of
      -- legacy rows with sparse address data.
      primary_loc := gen_random_uuid();
      INSERT INTO service_locations (id, customer_id, address_line1, address_line2, city, state, zip, is_primary, is_active, created_at)
      VALUES (primary_loc, est.customer_id,
              'Synthesized for legacy lead-less estimate (entity-redesign Phase D)', NULL,
              '', '', '', false, true, NOW());
    END IF;

    new_lead_id := gen_random_uuid();
    INSERT INTO leads (id, lead_number, customer_id, status, service_request,
                       service_location_id, organization_id, created_at, updated_at)
    VALUES (new_lead_id,
            alloc_prefix || lpad((alloc_next - 1)::text, alloc_padding, '0'),
            est.customer_id, 'WON'::"LeadStatus",
            'Synthesized for legacy lead-less estimate (entity-redesign Phase D)',
            primary_loc, est.organization_id, NOW(), NOW());

    UPDATE estimates SET lead_id = new_lead_id WHERE id = est.id;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- D1a — Deposit → kind=DEPOSIT Invoice dissolution (the core money migration)
-- For each legacy `deposits` row WHERE the estimate has NO kind=DEPOSIT invoice yet
-- (this SKIPS post-Phase-1 dual-written rows; D1a only dissolves PRE-redesign legacy
-- deposits). Per deposit, in one PL/pgSQL iteration:
--   (1) allocate the I##### number atomically (MIRROR numbering.ts; NEVER max+1);
--   (2) insert a kind=DEPOSIT Invoice (customer via estimate→lead→customer, FALLBACK
--       to estimates.customer_id which still exists at D1 time);
--   (3) insert ONE non-taxable invoice_line_items row;
--   (4) if PAID/REFUNDED: insert a Payment with amount = deposit.amount + surcharge_amount
--       (PRESERVE surcharge so net_collected = Σpayments − Σrefunds holds);
--   (5) if total_refunded>0 or a stripe_refund_id exists: insert a Refund.
-- IDEMPOTENCY KEY: the NOT-EXISTS-kind=DEPOSIT-invoice-for-estimate guard (one deposit per
-- estimate) makes the whole block re-runnable without double-insert.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  dep RECORD;
  alloc_next INT;
  alloc_prefix TEXT;
  alloc_padding INT;
  inv_id UUID;
  resolved_customer UUID;
  inv_status "InvoiceStatus";
  inv_amount_due NUMERIC(12,2);
  system_admin UUID;
BEGIN
  FOR dep IN
    SELECT d.*, e.id AS est_id, e.estimate_number, e.organization_id AS org_id, e.lead_id
    FROM deposits d
    JOIN estimates e ON e.id = d.estimate_id
    WHERE NOT EXISTS (
      SELECT 1 FROM invoices i WHERE i.estimate_id = d.estimate_id AND i.kind = 'DEPOSIT'
    )
  LOOP
    -- (1) Atomic I-number allocation (post-increment; allocated = next - 1).
    UPDATE organizations
    SET invoice_next_number = invoice_next_number + 1,
        invoice_first_issued_at = COALESCE(invoice_first_issued_at, NOW())
    WHERE id = dep.org_id
    RETURNING invoice_next_number, invoice_prefix, number_padding
    INTO alloc_next, alloc_prefix, alloc_padding;

    -- (2) Resolve customer: estimate → lead → customer, FALLBACK to estimate.customer_id.
    SELECT COALESCE(l.customer_id, e2.customer_id) INTO resolved_customer
    FROM estimates e2
    LEFT JOIN leads l ON l.id = e2.lead_id
    WHERE e2.id = dep.est_id;

    inv_status := CASE dep.status
                    WHEN 'PAID' THEN 'PAID'::"InvoiceStatus"
                    WHEN 'VOIDED' THEN 'VOIDED'::"InvoiceStatus"
                    WHEN 'REFUNDED' THEN 'REFUNDED'::"InvoiceStatus"
                    ELSE 'SENT'::"InvoiceStatus"
                  END;
    inv_amount_due := CASE WHEN dep.status IN ('PAID', 'REFUNDED') THEN 0 ELSE dep.amount END;

    inv_id := gen_random_uuid();
    INSERT INTO invoices (
      id, invoice_number, organization_id, job_id, kind, estimate_id, customer_id,
      status, public_token, subtotal, discount_amount, tax_rate, tax_amount,
      deposit_credit, total_amount, amount_due, net_collected, total_refunded,
      created_at, updated_at
    ) VALUES (
      inv_id,
      alloc_prefix || lpad((alloc_next - 1)::text, alloc_padding, '0'),
      dep.org_id, NULL, 'DEPOSIT', dep.est_id, resolved_customer,
      inv_status, gen_random_uuid(), dep.amount, 0, 0, 0,
      0, dep.amount, inv_amount_due,
      -- net_collected = Σpayments − Σrefunds (paid deposits carry amount+surcharge; else 0)
      (CASE WHEN dep.status IN ('PAID', 'REFUNDED') THEN dep.amount + COALESCE(dep.surcharge_amount, 0) ELSE 0 END) - COALESCE(dep.total_refunded, 0),
      COALESCE(dep.total_refunded, 0),
      NOW(), NOW()
    );

    -- (3) One non-taxable line.
    INSERT INTO invoice_line_items (id, invoice_id, sequence, description, quantity, unit_price, is_taxable, line_total)
    VALUES (gen_random_uuid(), inv_id, 1,
            'Deposit — ' || COALESCE(dep.deposit_percentage::text, '') || '% of ' || dep.estimate_number,
            1, dep.amount, false, dep.amount);

    -- (4) Collected Payment (PRESERVE surcharge in the amount).
    IF dep.status IN ('PAID', 'REFUNDED') THEN
      INSERT INTO payments (id, invoice_id, amount, method, paid_at, collected_by, stripe_payment_intent_id, reference_number, created_at)
      VALUES (gen_random_uuid(), inv_id,
              dep.amount + COALESCE(dep.surcharge_amount, 0),
              COALESCE(dep.payment_method, 'CARD'::"PaymentMethod"),
              COALESCE(dep.paid_at, dep.marked_received_at, NOW()),
              dep.marked_received_by, dep.stripe_payment_intent_id, dep.reference_number, NOW());
    END IF;

    -- (5) Refund row for any refunded amount.
    IF COALESCE(dep.total_refunded, 0) > 0 OR dep.stripe_refund_id IS NOT NULL THEN
      -- refunded_by FK is required; fall back to the org's first ADMIN as the system actor.
      SELECT u.id INTO system_admin FROM users u
      WHERE u.organization_id = dep.org_id AND u.role = 'ADMIN' ORDER BY u.created_at LIMIT 1;
      INSERT INTO refunds (id, invoice_id, payment_id, amount, tax_portion, non_taxable_concession,
                           method, reason, reason_category, stripe_refund_id, refunded_by, organization_id, created_at)
      VALUES (gen_random_uuid(), inv_id, NULL,
              COALESCE(dep.total_refunded, 0), 0, false,
              COALESCE(dep.payment_method, 'CARD'::"PaymentMethod"),
              dep.refund_reason, 'OTHER'::"RefundCategory",
              dep.stripe_refund_id, COALESCE(dep.refunded_by, system_admin), dep.org_id, NOW());
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- D1b — JobCharge → InvoiceLineItem (for any STANDARD invoice still deriving lines
-- from job_charges). Owned by THIS step ONLY (never D1a). Guard: skip invoices that
-- already have ≥1 owned invoice_line_items row.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO invoice_line_items (id, invoice_id, sequence, description, quantity, unit_price, is_taxable, line_total)
SELECT gen_random_uuid(), i.id, jc.sequence, jc.description, jc.quantity, jc.unit_price, jc.is_taxable, jc.line_total
FROM invoices i
JOIN job_charges jc ON jc.job_id = i.job_id
WHERE i.kind = 'STANDARD'
  AND i.job_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM invoice_line_items li WHERE li.invoice_id = i.id);

-- ─────────────────────────────────────────────────────────────────────────────
-- D1e — Invoice.customer_id backfill (legacy STANDARD invoices reached via job→customer;
-- deposit invoices already got customer_id in D1a). Guard: WHERE customer_id IS NULL.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE invoices i
SET customer_id = j.customer_id
FROM jobs j
WHERE i.customer_id IS NULL
  AND i.job_id IS NOT NULL
  AND j.id = i.job_id;
