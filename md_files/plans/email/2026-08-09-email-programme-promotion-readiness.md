# Email programme: promotion readiness and prod cutover

**Date:** 2026-08-09
**Status:** SUPERSEDED by `2026-08-10-email-prod-promotion-runbook.md`. Both code items below
shipped in #1460 and are verified on staging. Three claims in this document are WRONG and are
corrected in section 1 of the runbook: `email_sending_enabled` DOES already exist in prod with
deliberate per-org values; "promote with sending off" would have stopped live customer email for
three orgs; and the reply-domain split is NOT required, because Resend webhooks are account-wide
and unmatched events already exit cleanly in both environments. Kept for the reasoning trail.
**Scope:** what has to be true before the email programme (slices 1-10 plus the sender-address
work) can move from `staging` to `main`, and in what order.

## Verdict

Staging is nearly complete. The blocking work is **not** mostly code - it is one environment
constraint that no PR can fix, plus two code items.

- **Code left on staging:** slice-10 deletion, and the `email_sending_enabled` default.
- **Prod prep that must come first:** split the inbound reply domain per environment.
- **Not a blocker (corrected):** RLS on the new email tables. See below.

Promoting today would ship a prod that sends mail but silently receives nothing and never
records a delivery state.

## Corrected: RLS is already covered

Initially filed as an infrastructure gate. It is not - it is already code, and it ships with
the migrations.

Verified on staging (`knriiqdqxgfoecsfarlx`):

| Table | RLS enabled | Policies |
|---|---|---|
| `emails` | true | 1 |
| `email_threads` | true | 1 |
| `email_read_states` | true | 1 |
| `email_attachments` | true | 1 |
| `organization_domains` | true | 1 |

The `ENABLE ROW LEVEL SECURITY` statements live inside the migrations themselves
(`20260805100000_email_attachments`, `20260805140000_email_thread_and_read_state`,
`20260805150000_organization_domains`, `20260805160000_reply_tokens_and_inbound_match`), so
`prisma migrate deploy` carries them into prod unaided.

This is the opposite of #1276, where four tables reached prod with `relrowsecurity=false` and
zero policies precisely because their migrations omitted the statements. Still **verify after
the deploy** rather than assume - that is the lesson of #1276 - but do not treat it as
pre-work.

## The real constraint: one inbound domain cannot serve two environments

There is exactly one Resend webhook, and it points at staging:

```
https://alpha-crm-test-env.onrender.com/api/webhooks/resend
events: email.sent, email.delivered, email.delivery_delayed,
        email.complained, email.bounced, email.failed, email.received
```

One endpoint carrying both delivery events and inbound replies.

Domains on the shared Resend account:

| Domain | Sending | Receiving |
|---|---|---|
| `reply.servwave.com` | enabled | **enabled** |
| `mail.servwave.com` | enabled | disabled |
| `servwave.com` | enabled | disabled |

**Receiving is bound to MX records, which are DNS-global.** A domain delivers mail to exactly
one destination. Staging and prod cannot both receive on `reply.servwave.com` - whichever wins,
the other goes dark. Sending is safe to share; receiving is not. This is why the fix cannot be
"repoint the webhook at prod": that would simply move the outage onto staging.

### The fix

Split the reply domain per environment:

- **prod** keeps `reply.servwave.com`
- **staging** moves to `reply.staging.servwave.com` (new domain in Resend, its own MX records,
  receiving enabled, its own webhook endpoint)

`replyAddressFor()` already reads `env.EMAIL_REPLY_DOMAIN` and never derives the domain from
anything org-specific, so this is **DNS plus one environment variable - no code change**. It
depends on none of the new schema, which is what makes it doable entirely before promotion.

### Why cross-talk is not a risk

Reply tokens are 128-bit CSPRNG values used as **opaque per-database lookup keys**, not signed
payloads. A token minted in prod has no row in staging's table. So even if both environments
observed the same event stream, neither could resolve - let alone mis-route - the other's
replies. A decision made for security turns out to make environment separation safe by
construction.

## Code items still open on staging

### 1. Slice-10 deletion

The guided custom-domain feature's UI was replaced by Settings -> Sender Address (#1444), but
its backend is untouched and still mounted:

- `controllers/organization-email-domain.controller.ts`
- `lib/organization-domain.ts`, `lib/dns-provider.ts`
- the four `/email-domain` routes in `routes/organization.routes.ts`
- the `OrganizationDomain` model and its relation
- the webhook's `domain.*` branch, `sendDomainVerifiedEmail`
- the custom-domain fallback branch in `resolveFromAddress`

**`organization_domains` does not exist in prod.** Promoting live routes over a missing table
is a straight 500 on every one of them. Delete before promotion, not after.

### 2. `email_sending_enabled` defaults to `true`

The column default means the migration switches sending **on for every existing prod org** the
moment it applies. Those orgs have real customers.

Recommendation: make email match phone, which ships **off by default for every new org
regardless of plan**. Promote with sending off and enable per org deliberately, the same shape
already applied on staging. This is a code decision to settle before the promotion PR.

## Decision to make (not a defect)

Every customer-facing email in prod changes sender address, from
`no-reply@mail.servwave.com` to `alphadoorssecurity@mail.servwave.com` and equivalents.

Verified: prod currently sends as `no-reply@` (a B&G Cabinet estimate on 2026-08-08), while
staging already sends as the derived local part. Customer-side filters and saved contacts will
stop matching. This is the intended product change - it should ship because the moment was
chosen, not as a side effect of a promotion.

## Order of work

**Phase A - prod prep, before any PR.** Nothing here depends on the new schema.

1. Create `reply.staging.servwave.com` in Resend, publish its MX records, enable receiving.
2. Point staging's `EMAIL_REPLY_DOMAIN` at it; add a staging webhook endpoint.
3. Verify a real reply still lands on staging.
4. Settle the `email_sending_enabled` default.
5. Decide how the sender-address change is communicated.

**Phase B - code.**

6. Slice-10 deletion PR into `staging`; verify.
7. Promotion PR. Re-run the gate first:
   `git merge-base --is-ancestor origin/main origin/staging` (exit 0 -> branch off `main`,
   non-zero -> branch off `staging`). It has been non-zero throughout; a tree diff is not a
   substitute for it.

**Phase C - cutover.** The prod webhook is the only step that genuinely cannot move earlier,
because its destination has to exist first.

8. Migrations create the tables and their RLS.
9. Add the prod webhook against `reply.servwave.com`.
10. **Verify RLS actually landed** - `relrowsecurity` and policy counts, per #1276.
11. Leave sending off. Confirm one real send on the wire, then enable a single org.

## Verified state at time of writing

- Sender-address feature live on staging and confirmed on the wire as
  `ServWave Test <support@mail.servwave.com>`.
- Staging orgs: sending enabled for **ServWave Test only**; all others false. Only ServWave
  Test carries an override (`support`); every other org still derives from its name.
- Malformed `from` rows: **0 on staging** (one legacy row deleted), **0 of 32 in prod** - so
  the #1458 crash class cannot bite at promotion.
- Merged this session: #1373, #1375, #1447, #1444, #1459.
- Open issues: #1445 (impeccable hook scans backend email templates), #1458 (the Sent crash,
  fixed by #1459).
