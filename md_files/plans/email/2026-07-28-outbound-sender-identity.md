# Outbound sender identity: org display name + dedicated sending domain

**Date:** 2026-07-28
**Branch:** `feat/outbound-sender-identity`
**Scope:** outbound only. Inbound reply aliases and threading are deliberately deferred to the
Linear project "Inbox: per-org reply aliases and inbound threading" (ServWave team, Backlog).

## Problem

Every org sends from one global address with no display name:

- `env.EMAIL_FROM` defaults to `no-reply@servwave.com` (`backend/src/config/env.ts:76`).
- All 20-odd business senders in `backend/src/lib/email.ts` pass `from: env.EMAIL_FROM`.
- The org name reaches the customer only in the subject and HTML body.

So a homeowner sees mail from a third party rather than the contractor they hired, and
`sendInvoiceEmail` makes it literal: the subject is hard-coded `Invoice {n} from ServWave`
while the estimate sender correctly interpolates the org name.

Second problem, invisible until it hurts: high-volume contractor mail and auth-critical mail
(MFA codes, user invites) share one domain reputation. One contractor blasting estimates at
stale addresses can degrade deliverability of password resets and login codes.

## Decisions

1. **Display name is locked and derived from `organization.name`.** Not user-editable, no new
   settings surface, no new column.
2. **Business email moves to `mail.servwave.com`. Auth email stays on `servwave.com`.** This
   requires splitting the single `EMAIL_FROM` into two env vars, since today one constant feeds
   both paths.
3. **`dispatchEmail` becomes the sole authority on the From header.** It already fetches the org
   for the `email_sending_enabled` kill switch, so it can fetch the name in the same query. Call
   sites stop passing `from` entirely, enforced by the type system.
4. **Platform-voice senders opt out.** A few emails are ServWave speaking *to* the contractor,
   not the contractor speaking to their customer. Stamping the org name on those is wrong.

## Sender classification

Auth-critical senders bypass `dispatchEmail` and call `resend.emails.send` directly, so they are
untouched by construction (the existing separation documented at `lib/email.ts:23-28`):

- `sendUserInviteEmail`, `sendMfaCodeEmail`, `sendAiFarmBookingEmails`.

Platform voice, routed through `dispatchEmail`, must opt out via `senderIdentity: 'platform'`:

- `sendPaymentsActionNeededEmail` - ServWave Payments telling the contractor Stripe needs something.
- `sendPaymentsRateChangeNotice` - ServWave Payments processing-rate notice.
- `sendPaymentReceivedAlert` - `[Internal]` ops alert, addressed to ServWave itself.

Everything else defaults to org voice.

## Implementation

### Config (`backend/src/config/env.ts`)

- `EMAIL_FROM` keeps its default `no-reply@servwave.com`. Now explicitly the **auth/platform**
  address. Comment updated to say so.
- New `EMAIL_FROM_BUSINESS`, default `no-reply@mail.servwave.com`. Every customer-facing send.

Two vars rather than one means the domain cutover is a config flip per environment, not a deploy,
and it can land before DNS is verified without changing behaviour.

### `dispatchEmail` (`backend/src/lib/email.ts`)

```
dispatchEmail(organizationId, payload, options?)
  payload:  DistributiveOmit<CreateEmailOptions, 'from'>
  options:  { senderIdentity?: 'organization' | 'platform' }   // default 'organization'
```

`CreateEmailOptions` is a union (`RequireAtLeastOne<EmailRenderOptions>` vs template form), so a
plain `Omit` would collapse it and lose the html/text/react members. Use a distributive omit.

Behaviour:
- Org lookup selects `email_sending_enabled` **and** `name` in the one existing query.
- `senderIdentity: 'platform'` sends bare `env.EMAIL_FROM_BUSINESS`, no display name.
- Otherwise `"<sanitized org name>" <no-reply@mail.servwave.com>`.
- Blank or missing org name falls back to the bare address rather than emitting `"" <addr>`.

Removing `from` from the payload type is the point: it makes it impossible for a future sender to
set its own From, and `tsc` sweeps all existing call sites for me.

### Display-name encoding (`formatSenderIdentity`)

`organization.name` is tenant-controlled input going into a mail header, so it gets the same
distrust as any user string entering HTML:

- Strip CR, LF, and other control characters. Header injection is the real risk here: a name
  containing a newline could inject `Bcc:` into the message.
- Collapse runs of whitespace, trim, truncate to 64 characters.
- Non-ASCII names get RFC 2047 encoded-word form (`=?UTF-8?B?...?=`), which also sidesteps the
  75-character-per-word limit at that length.
- ASCII names are emitted as an RFC 5322 quoted-string with `\` and `"` escaped.
- Empty after sanitizing means no display name at all.

### Invoice subject fix

`sendInvoiceEmail` hard-codes `Invoice {n} from ServWave`. Resolve the org name and interpolate it,
matching `sendEstimateEmail`. Neither controller caller has the org name in hand, so the lookup
happens inside the sender (the same shape `sendUserInviteEmail` already uses for its branding
lookup). Cost is one extra cheap query on invoice sends only.

## Tests (TDD, written first)

`backend/src/__tests__/email-sender-identity.test.ts`:

1. Customer-facing send carries `"Acme Plumbing" <no-reply@mail.servwave.com>`.
2. Business sends use the business domain, never the auth domain.
3. MFA and invite mail still use the auth domain with no org branding.
4. Platform-voice senders send bare, with no org display name.
5. Header injection: a name containing CRLF cannot inject a header.
6. Quotes and backslashes in a name are escaped, not emitted raw.
7. Non-ASCII name is RFC 2047 encoded.
8. Blank org name degrades to the bare address.
9. Invoice subject names the org, not ServWave.

## Ran's side (blocking the domain flip only, not the code)

1. Add `mail.servwave.com` as a sending domain in Resend, region matching prod (Virginia).
2. Publish the DKIM, SPF, and DMARC records Resend generates, at the subdomain.
3. Confirm `servwave.com` keeps its own records untouched.
4. Warm the subdomain before cutover; do not move all volume on day one.
5. Set `EMAIL_FROM_BUSINESS=no-reply@mail.servwave.com` in staging, verify, then prod.

Until step 5, the code ships and behaves exactly as today apart from the display name and the
invoice subject, because the default can stay on the current address per environment.

## Deliberately not in scope

- Reply-To of any kind. Without inbound handling a Reply-To would point somewhere nobody reads,
  which is the status quo dressed up. It lands with the inbound project.
- Per-org custom sending domains (contractor-owned DNS).
- `sendPaymentReceivedAlert` addresses its `[Internal]` alert to `env.EMAIL_FROM`, a no-reply
  mailbox. Pre-existing oddity, noted, not fixed here.
