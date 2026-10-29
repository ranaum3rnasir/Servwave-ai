# Auth & Public module - behaviour map (UI kit migration, Phase 1)

Status: mapping complete, 2026-07-29. Read-only documentation. No code was modified.
Module 13 in `md_files/plans/ui-redesign/UI_KIT_MIGRATION_PLAN.md` section 5.
Scope: `/login`, `/auth/callback`, `/accept-invite`, `/p/estimates/:id`, `/p/invoices/:id`,
`NotAuthorizedPage` (no route of its own), `/design-system`.

Method: every statement below was read from the named file at the named line range. Anything that
could not be determined from source is in section 11 (Open questions), not guessed.

---

## 0. File inventory

### Pages owned by this module

| File | Lines | Route | Loaded how |
|---|---|---|---|
| `frontend/src/pages/LoginPage.tsx` | 295 | `/login` | eager (`App.tsx:8`) |
| `frontend/src/pages/AuthCallbackPage.tsx` | 52 | `/auth/callback` | eager (`App.tsx:9`) |
| `frontend/src/pages/AcceptInvitePage.tsx` | 191 | `/accept-invite` | lazy (`App.tsx:10`) |
| `frontend/src/pages/PublicEstimatePage.tsx` | 797 | `/p/estimates/:id` | lazy (`App.tsx:52`) |
| `frontend/src/pages/PublicInvoicePage.tsx` | 680 | `/p/invoices/:id` | lazy (`App.tsx:55`) |
| `frontend/src/pages/NotAuthorizedPage.tsx` | 28 | none - rendered by `ProtectedRoute` | eager via ProtectedRoute |
| `frontend/src/pages/design-system/DesignSystemPage.tsx` | 718 | `/design-system` | lazy (`App.tsx:11`) |

### Non-page files this module depends on

| File | Role |
|---|---|
| `frontend/src/components/ProtectedRoute.tsx` (33 lines) | auth gate + NotAuthorizedPage host |
| `frontend/src/stores/auth.store.ts` (229 lines) | zustand auth store, all auth mutations |
| `frontend/src/lib/supabase.ts` | Supabase client + synchronous `getAccessToken()` cache |
| `frontend/src/lib/auth-listener.ts` | global `onAuthStateChange` handler, called once at `App.tsx:18` |
| `frontend/src/lib/axios.ts` | JWT request interceptor + 401 refresh-once + 429 handler |
| `frontend/src/lib/api/invite.ts` (21 lines) | `getInviteInfo` / `acceptInvite` |
| `frontend/src/lib/utils.ts` | `extractApiError`, `formatCurrency`, `formatPhone`, `cn` |
| `frontend/src/lib/safe-href.ts` | sanitises the org website link on the public estimate footer |
| `frontend/src/lib/customer-name.ts` | `customerDisplayName` |
| `frontend/src/constants/estimateStatus.ts` | `ESTIMATE_STATUS.WON` / `.ARCHIVED` |
| `frontend/src/components/brand/ServWaveMark.tsx` | logo mark on Login + AcceptInvite |

### Cross-module shared components (FLAGGED - changing these breaks other modules)

| Component | Path | Also used by |
|---|---|---|
| **`EstimateDocumentView`** | `components/estimates/EstimateDocumentView.tsx` (184 lines) | `PublicEstimatePage.tsx:613`, **`EstimateDetailPage.tsx:1064`**, **`EstimateFormPage.tsx:710`**, asserted by `frontend/src/__tests__/estimate-detail-preview.test.tsx` |
| `Card`, `Button`, `Checkbox`, `Dialog*` | `components/ui/*` | app-wide |
| `Table`, `Tabs`, `Badge`, `DataTable`, `TrendDelta`, `SectionCard`, `components/charts/*` | various | app-wide, consumed only for display by `/design-system` |

**Correction to the invoices behaviour map.** `md_files/specs/ui-redesign/invoices-behavior-map.md`
states that `PublicInvoicePage.tsx` imports `LineItemsTable` from `components/jobs/items/`. It does
NOT. Verified two ways: (a) `PublicInvoicePage.tsx` imports only `Card`, `Button`, lucide icons and
`formatCurrency`/`formatPhone` (lines 1-17); (b) a repo-wide grep for `LineItemsTable` returns only
`components/jobs/items/LineItemsTable.tsx`, `components/jobs/items/LineItemsEditor.tsx` and
`components/invoices/InvoiceLineItemsEditor.tsx`. `PublicInvoicePage` renders its own local
`renderLineItemsTable()` (lines 271-355) as a raw `<table>`. So **the only real cross-module shared
component in this module is `EstimateDocumentView`.**

---

## 1. The AppLayout boundary

`frontend/src/App.tsx:99-191` has exactly two tiers:

```
<SentryRoutes>                                     // Sentry.withSentryReactRouterV7Routing(Routes)
  /login              -> LoginPage                 // line 100  OUTSIDE
  /auth/callback      -> AuthCallbackPage          // line 101  OUTSIDE
  /accept-invite      -> AcceptInvitePage          // line 102  OUTSIDE
  /p/estimates/:id    -> PublicEstimatePage        // line 103  OUTSIDE
  /p/invoices/:id     -> PublicInvoicePage         // line 104  OUTSIDE
  /design-system      -> DesignSystemPage          // line 107  OUTSIDE
  <ProtectedRoute allowedRoles={[ADMIN,SALES,DISPATCHER,TECHNICIAN]}>   // line 111
    <AppLayout>                                                          // line 112
      ... all ~45 authed routes ...
    </AppLayout>
  </ProtectedRoute>
  *                   -> <Navigate to="/" replace/>    // line 190
</SentryRoutes>
```

What "OUTSIDE AppLayout" concretely means for these 6 routes (read from
`components/layout/AppLayout.tsx:41-118`):

- **No `TooltipProvider`.** AppLayout mounts it at line 42. Any kit component that requires a
  tooltip context must bring its own provider on these pages, or it will throw.
- **No sidebar, no header, no global search, no notification bell, no dialer, no copilot,
  no AiCenterModal, no ClockInOutMenu.**
- **No `useOrganization()` org-formatting hydration.** AppLayout calls `setOrgFormattingPrefs`
  (lines 26-34) so `formatCurrency` / `formatExactDate` honour the org's currency and date format.
  On the public pages that never runs, so `formatCurrency` uses its built-in default. Any v2 build
  must NOT "fix" this by adding the hook - it would fire an authed API call from an unauthenticated
  page.
- **No `<main>` scroll container.** Each of these pages owns its own full-viewport shell:
  Login `h-screen`, AuthCallback `h-screen`, AcceptInvite `h-screen`, both public pages
  `fixed inset-0 ... overflow-y-auto`, DesignSystem its own page shell.
- **`<Toaster />` IS still mounted** - it lives in `AppWithAbility` (`App.tsx:204`), outside
  `AppRoutes`. So `useToast()` works on public routes. None of these six pages uses it today; they
  each hand-roll their own error banner or local toast state.
- **`ErrorBoundary` and `AbilityProvider` are also outside** (`App.tsx:199-206`), so an ability
  context exists on public routes - it is just `emptyAbility` for a signed-out visitor.
- **`QueryClientProvider` is mounted app-wide** (`App.tsx:212`), but none of these six pages uses
  TanStack Query. Every fetch here is bare `fetch()` or the axios instance.

`NotAuthorizedPage` is the exception: it has no route, and it renders **inside** AppLayout, because
`ProtectedRoute` returns it in place of `<Outlet/>` (`ProtectedRoute.tsx:29`) at a route nested
under `<AppLayout>`.

---

## 2. `ProtectedRoute` - the gate itself

`components/ProtectedRoute.tsx`:

| State | Render |
|---|---|
| `isLoading` | full-screen centred `<div className="text-text-secondary">Loading...</div>` (lines 17-21) |
| `!isAuthenticated` | `<Navigate to="/login" replace />` (line 25) - **always**, `fallback` is ignored |
| `allowedRoles` set and `user.role` not in it, `fallback` truthy | `<NotAuthorizedPage />` (line 29) |
| same, `fallback` falsy | `<Navigate to="/" replace />` (line 29) |
| otherwise | `<Outlet />` |

Props: `allowedRoles?: Array<'ADMIN'|'SALES'|'DISPATCHER'|'TECHNICIAN'>`, `fallback?: boolean`.
Consumers with `fallback` today: `/invoices/new` (ADMIN+DISPATCHER, `App.tsx:137`),
`/reports` + `/reports/:slug` (ADMIN+DISPATCHER, line 144), `/users` + `/settings/organization`
(ADMIN, line 170).

Note `ProtectedRoute` uses `useAuthStore()` with no selector, so it re-renders on any store change.

---

## 3. Auth flow (Supabase Auth, admin-created users only)

### 3.1 Store surface (`stores/auth.store.ts`)

| Action | Calls | Notes |
|---|---|---|
| `login(email, password)` | `POST /api/auth/login` | returns `{mfaRequired:false}` or `{mfaRequired:true, challengeId}` |
| `verifyMfa(challengeId, code)` | `POST /api/auth/mfa/verify` | |
| `loginWithGoogle()` | `supabase.auth.signInWithOAuth({provider:'google', options:{redirectTo: origin + '/auth/callback'}})` | full-page redirect |
| `finalizeOAuthLogin()` | `POST /api/auth/google/finalize` | gatekeeper - returns `{user, abilityRules}` |
| `logout()` | `POST /api/auth/logout` (errors swallowed) then `supabase.auth.signOut()` | clears both caches |
| `checkAuth()` | `GET /api/auth/me` | on failure signs out and clears caches |
| `applyUserPatch(patch)` | none | merge-in-place for profile edits |

`establishSession(user, session)` (lines 112-125) is the shared post-credential path used by BOTH
the no-MFA login and the `verifyMfa` completion: `supabase.auth.setSession({access_token,
refresh_token})` -> `GET /api/auth/me` -> `buildAbility(meData.abilityRules ?? [])` -> write
`localStorage['servwave_user']` and `localStorage['servwave_ability_rules']` -> set store.

Optimistic boot (lines 102-132): the cached user and cached ability rules are read from
localStorage at module load, so `isAuthenticated` is true on first paint after a refresh;
`checkAuth()` validates in the background.

`extractApiError(err, fallback)` from `lib/utils` converts an axios error into the message string
that every one of these pages shows.

### 3.2 Backend routes actually mounted (`backend/src/routes/auth.routes.ts`)

`POST /api/auth/login` (unscoped + authLimiter) · `POST /api/auth/logout` (authenticate) ·
`POST /api/auth/refresh` · `POST /api/auth/google/finalize` (unscoped + authLimiter) ·
`GET /api/auth/me` (authenticate) · `POST /api/auth/invite` · `POST /api/auth/accept-invite` ·
`POST /api/auth/mfa/verify` · `POST /api/auth/mfa/resend` (mfaResendLimiter) ·
`POST /api/auth/mfa/setup|enable|disable` (authenticate) · `GET /api/auth/mfa/status`.

There is **no signup route**. Users exist only because an admin created or invited them - this is
what makes Google OAuth "an extra credential for an existing user" rather than a sign-up path.
`POST /api/auth/google/finalize` is the gatekeeper that decides whether the Supabase-authenticated
Google identity maps to an existing Prisma user.

### 3.3 Global auth listener (`lib/auth-listener.ts`, invoked at `App.tsx:18`)

`supabase.auth.onAuthStateChange` switch:
- `INITIAL_SESSION` - **skipped entirely when `window.location.pathname === '/auth/callback'`**
  (so it cannot race AuthCallbackPage's finalize). Otherwise: session present -> `checkAuth()`;
  absent -> set `{user:null, isAuthenticated:false, isLoading:false}`.
- `SIGNED_IN` - same `/auth/callback` skip, then `supabase.realtime.setAuth(token)` and `checkAuth()`
  (covers cross-tab sign-in).
- `SIGNED_OUT` - `setCachedUser(null)` and reset store (cross-tab sign-out sync).
- `TOKEN_REFRESHED` - `supabase.realtime.setAuth(token)` only.

### 3.4 Axios interceptors (`lib/axios.ts`)

- Request: attaches `Authorization: Bearer <getAccessToken()>` synchronously from the cached token.
- Response 401, once per request (`_retry` + module-level `isRefreshing` flag): `supabase.auth
  .refreshSession()`; on refresh error or throw -> `window.location.href = '/login'` (a hard
  navigation, not a router navigate).
- Response 429 -> `handle429(error, toast, Date.now)`.

---

## 4. `/login` - LoginPage

### 4.1 Two mutually exclusive phases

`mfaChallengeId` (state, line 30) is the switch. `null` -> password phase. Non-null -> code phase.
Heading text swaps: `'Sign In'` vs `'Verify it's you'` (line 155, uses a U+2019 right single quote).

### 4.2 Component tree

```
div.flex.h-screen
├─ div (left brand panel, hidden below lg)  -- ServWaveMark + wordmark + tagline + 3 value props with Check icons
└─ div (right form panel)
   ├─ mobile-only logo lockup (lg:hidden)
   └─ div.max-w-sm > div (white card, shadow-xl)
      ├─ h2  "Sign In" | "Verify it's you"
      ├─ {error && div.bg-danger/10}                     -- single error banner, both phases
      └─ phase === mfa ?
         ├─ p  "We emailed you a 6-digit verification code..."
         ├─ form onSubmit=onVerify
         │  ├─ label[for=mfa-code] + input#mfa-code
         │  └─ button[type=submit] "Verify" / "Verifying..."
         ├─ {resendMsg && p.text-success}
         └─ button "Resend code"
       : (password phase)
         ├─ form onSubmit=handleSubmit(onSubmit)
         │  ├─ label[for=email]    + input#email    (RHF register('email'))
         │  ├─ {errors.email && p.text-danger}
         │  ├─ label[for=password] + input#password (RHF register('password'))
         │  ├─ {errors.password && p.text-danger}
         │  └─ button[type=submit] "Sign In" / "Signing in..."
         ├─ divider "or"
         └─ button "Sign in with Google" (inline 4-path Google SVG, hard-coded brand hex)
```

### 4.3 Form + validation

`loginSchema` (lines 12-15), RHF + `zodResolver`:

| Field | Rule | Message |
|---|---|---|
| `email` | `z.string().email(...)` | `Enter a valid email` |
| `password` | `z.string().min(1, ...)` | `Password is required` |

MFA code input (lines 177-190): `type=text`, `inputMode="numeric"`,
`autoComplete="one-time-code"`, `maxLength={6}`, `autoFocus`, `onChange` strips every non-digit
(`e.target.value.replace(/\D/g,'')`). Submit is `disabled={isSubmitting || code.length < 6}`.
`onVerify` sends `code.trim()`.

Password-phase submit is `disabled={isSubmitting}` only - zod handles the rest.

### 4.4 Behaviour of each interactive element

| Element | Effect |
|---|---|
| Sign In (submit) | `login(email, password)`. `mfaRequired` -> `setMfaChallengeId(result.challengeId)` and stay. Else `navigate('/', {replace:true})`. Throw -> `setError(err.message \|\| 'Login failed')`. `finally` clears `isSubmitting`. |
| Verify (submit) | guards on `mfaChallengeId`, clears `error` + `resendMsg`, `verifyMfa(...)`, then `navigate('/', {replace:true})`. Throw -> `setError(err.message \|\| 'Verification failed')`. |
| Resend code | `POST /api/auth/mfa/resend {challengeId}` via the axios instance. Success -> `setResendMsg('A new code has been sent.')`. Failure -> `setError(extractApiError(err, 'Could not resend the code. Try again in a moment.'))`. Note: it is NOT rate-limited or disabled client-side; the backend has `mfaResendLimiter`. |
| Sign in with Google | `loginWithGoogle()` - full-page redirect to Google. No loading state, no disabled state, errors are not caught here. |

**Error seeding from the URL:** `useState(searchParams.get('error'))` (line 25). `/login?error=...`
renders that string in the danger banner on first paint. This is exactly what AuthCallbackPage
navigates to on a rejected OAuth finalize.

### 4.5 States

- Loading: no page-level loading state. Buttons show `Signing in...` / `Verifying...` and disable.
- Empty: n/a.
- Error: one shared `error` string, rendered in a `bg-danger/10 text-danger` banner above the form
  in both phases. Field errors render under their own input in `text-xs text-danger`.
- There is no "forgot password" affordance anywhere on this page.

### 4.6 Selector surface

No `data-testid` anywhere in this file. Playwright depends on (verified in
`frontend/e2e/global-setup.ts:33-42`, the shared login helper used by every authed spec):

```
page.goto('/login')
page.getByRole('heading', { name: 'Sign In' })      // exact text
page.locator('#email')
page.locator('#password')
page.getByRole('button', { name: 'Sign In', exact: true })
```

So the load-bearing selectors are: **`id="email"`, `id="password"`, the accessible name
`Sign In` on both the `<h2>` and the submit `<button>`**. Changing the heading string or the
button label breaks the login helper and therefore every authed e2e spec at once. Other stable
handles: `id="mfa-code"`, and the label/`htmlFor` pairs `email`, `password`, `mfa-code`.

---

## 5. `/auth/callback` - AuthCallbackPage

52 lines. Renders a single centred `Signing you in...` div; there are no interactive elements.

Flow (lines 18-44):
1. `ran` ref guards against double-invocation (StrictMode double effect).
2. `supabase.auth.getSession()`. If a session already exists -> `finalize()`.
3. Otherwise subscribe to `supabase.auth.onAuthStateChange`; the first callback with a session
   unsubscribes and calls `finalize()`.
4. `finalize()` = `await finalizeOAuthLogin()` (`POST /api/auth/google/finalize`) then
   `navigate('/', {replace:true})`.
5. On throw: `await supabase.auth.signOut()`, then
   `navigate('/login?error=' + encodeURIComponent(extractApiError(err,'Google sign-in failed')), {replace:true})`.

The Supabase client is created with `detectSessionInUrl: true` (`lib/supabase.ts`), which is what
exchanges the OAuth code before this page's effect sees a session.

There is **no visible error state on this page** - every failure leaves via `/login?error=`.
No timeout: if Supabase never produces a session the page shows `Signing you in...` forever
(recorded in Open questions).

Selector surface: the literal text `Signing you in…` (U+2026 ellipsis). No ids, no testids.

---

## 6. `/accept-invite` - AcceptInvitePage

### 6.1 Token flow

Token comes from `?token=` (`searchParams.get('token') ?? ''`, line 12). Three phases
(`type Phase = 'loading' | 'ready' | 'invalid'`):

- No token -> immediately `setPhase('invalid')`.
- `getInviteInfo(token)` = **`POST /api/auth/invite` with `{token}` in the BODY** - deliberately
  POST, per the comment in `lib/api/invite.ts:8-12`, so the single-use token never lands in
  backend request logs or proxy access logs. Resolves `{email, first_name}` -> `phase='ready'`.
  Rejects -> `phase='invalid'`.
- The effect uses an `active` flag cleanup to avoid a setState after unmount.

### 6.2 Renders per phase

| Phase | Content |
|---|---|
| `loading` | `p` "Loading your invitation…" |
| `invalid` | `p.text-danger` "This invitation link is invalid or has expired." + button "Go to sign in" -> `navigate('/login')` |
| `ready` | `h2` "Welcome{, firstName}" · `p` "Set a password for **{email}** to finish setting up your account." · optional error banner · password form · "or" divider · "Continue with Google" button · footnote "Use Google with **{email}** - no password needed." |

All three sit inside one white card with the ServWaveMark + wordmark lockup at the top.

### 6.3 Form + validation (hand-rolled, NOT RHF/zod)

Fields: `password` (`id="password"`, `type=password`, `autoComplete="new-password"`), `confirm`
(`id="confirm"`, same). Controlled `useState`.

`onSubmit` (lines 46-67), validation in order:
1. `password.length < 8` -> `setError('Password must be at least 8 characters.')`, return.
2. `password !== confirm` -> `setError('Passwords do not match.')`, return.
3. `acceptInvite(token, password)` = `POST /api/auth/accept-invite {token, password}`.
4. Then `login(email, password)` (the full store login).
5. Then `navigate('/', {replace:true})`.
6. catch -> `setError(extractApiError(err,'Could not complete your invitation.'))`.
7. `finally` -> `setSubmitting(false)`.

Submit button `disabled={submitting}`, label `Set password & sign in` / `Setting up…`.

**Known gap:** step 4 calls `login()` and ignores the returned `LoginResult`. If the invited user's
org has email-OTP MFA on, `login()` resolves `{mfaRequired:true, challengeId}` with NO session set,
and this page still navigates to `/` - which `ProtectedRoute` then bounces to `/login`. Recorded in
Open questions; do not "fix" it in a presentation-only v2 page.

"Continue with Google" -> `loginWithGoogle()`, same full-page redirect as LoginPage.

### 6.4 Selector surface

No testids. Stable handles: `id="password"`, `id="confirm"`, label `htmlFor` pairs, button text
`Set password & sign in`, `Go to sign in`, `Continue with Google`, and the three phase strings.
No e2e spec in `frontend/e2e/` references `/accept-invite` (grep found none).

---

## 7. `/p/estimates/:id` - PublicEstimatePage (customer-facing, token auth, no login)

### 7.1 Token model

- `id` from the path, `token` from `?token=` (lines 153-155). `paymentParam` from `?payment=`.
- **No token -> `setError('Invalid link — token missing')`, `setLoading(false)`, nothing fetched.**
  (Source uses a literal em dash in that string.)
- Every request is a bare `fetch()` against `${import.meta.env.VITE_API_URL || ''}` with
  `?token=${encodeURIComponent(token)}`. The axios instance and its Bearer interceptor are never
  used here, so no Supabase session is required or sent.
- Backend (`backend/src/routes/estimate.routes.ts:13-17`), all before `router.use(authenticate)`:
  - `GET /:id/public/pdf` - `unscopedRequest`, `publicReadLimiter`
  - `GET /:id/public` - `unscopedRequest`, `publicReadLimiter`
  - `POST /:id/approve` - `unscopedRequest`, `publicActionLimiter`
  - `POST /:id/decline` - `unscopedRequest`, `publicActionLimiter`
  `unscopedRequest` marks the request cross-tenant for RLS; the token is the only credential.

### 7.2 API calls

| Trigger | Call | Response consumed |
|---|---|---|
| mount (token present) | `GET /api/estimates/:id/public?token=` | `data.estimate` (+ `organization` merged in), `data.payment_instructions`, `data.surcharge_rate` (default `0.035`), `data.expired` |
| `?payment=success` or `=cancelled` | re-runs `fetchEstimate()` | same |
| Approve | `POST /api/estimates/:id/approve?token=` body `{payment_method, signature_data?, terms_accepted}` | `data.checkout_url` -> `window.location.href = checkout_url`; else `setEstimate(data.estimate)` and `setSelectedMethod(null)` |
| Decline | `POST /api/estimates/:id/decline?token=` (no body) | `setEstimate(data.estimate)` |
| Download PDF (anchor) | `GET /api/estimates/:id/public/pdf?token=` in a new tab | n/a - `target="_blank" rel="noopener noreferrer"` |

Non-OK responses: fetch of the document -> `setError('This estimate is no longer available.')`.
Approve/decline -> parse the body and throw `data.error || 'Action failed'`, caught into `error`.

No TanStack Query, no cache keys, no polling, no websocket anywhere on this page.

### 7.3 Derived status flags (lines 266-279)

```
isActionable   = status === 'SENT' && !isExpired
isPending      = status === 'PENDING'
isApproved     = status === ESTIMATE_STATUS.WON        // renamed from APPROVED
isDeclined     = status === 'DECLINED'
isCancelled    = status === ESTIMATE_STATUS.ARCHIVED   // renamed from CANCELLED
depositInvoice = estimate.invoices?.[0]
depositRequired= !!(send_config?.deposit_required && depositInvoice)
depositAmount  = send_config.deposit_amount ?? depositInvoice.total_amount ?? 0
surchargeAmount= depositAmount * surchargeRate
needsPayment   = depositRequired && sigDrawn
approveDisabled= !sigDrawn || (org.estimate_terms && !termsAgreed) || actionLoading
```

`ESTIMATE_STATUS.WON` / `.ARCHIVED` come from `constants/estimateStatus.ts` - the rename landed in
commit `cb3422b4`. Any v2 page must import the constants, never the literals.

### 7.4 Component tree

```
div.fixed.inset-0.overflow-y-auto
├─ org branding bar   style={{backgroundColor: org.brand_color || '#0C2D3A'}}
│  ├─ org.logo_url ? <img maxHeight 40px> : <span>{org.name || 'ServWave'}</span>
│  └─ {token && estimate && <a "Download PDF" target=_blank>}
└─ div.max-w-2xl.mx-auto
   ├─ {error && estimate && Card.bg-red-50}                    -- non-fatal error banner
   ├─ <EstimateDocumentView ... />                             -- CROSS-MODULE (see 7.7)
   ├─ {depositRequired && Card "Deposit required: $X (N% of total)"}
   ├─ renderStatusBanner()                                     -- see 7.5
   ├─ {signature_data && (isApproved||isPending) && Card "Customer Signature" + <img> + signed-at}
   ├─ {org.estimate_terms && isActionable && Card "Terms & Conditions" + truncated-to-200-chars
   │     preview + "See attached PDF for full terms" + <Checkbox> "I agree to the terms and conditions"}
   ├─ {isActionable && Card "Signature *" + <SignatureCanvas> + "Clear" ghost button}
   ├─ {isActionable && !needsPayment && Card [Approve Estimate | Decline] + "Please sign above to approve"}
   ├─ {isActionable && needsPayment && renderPaymentMethodButtons()}
   ├─ {isActionable && depositRequired && !sigDrawn && Card "Please sign above to proceed to payment"
   │     + [Decline Estimate]}
   ├─ <Dialog open={confirmDecline}> "Decline Estimate" -> [Go Back | Yes, Decline]
   └─ {org && footer: name / email / website(safeHref, target=_blank)}
```

### 7.5 `renderStatusBanner()` - priority order (lines 456-574)

1. `paymentBanner` (from `?payment=`) - green success or amber warning.
2. `isExpired` - amber "Estimate Expired".
3. `isCancelled` - slate "Estimate Cancelled".
4. `isDeclined` - slate "Estimate Declined" + declined_at localeString or `—`.
5. `isApproved` - green "Estimate Approved" + approved_at, plus "Deposit of $X received." when
   `depositInvoice.status === 'PAID'`.
6. `isPending` - blue "Deposit Pending" + amount + "Once we receive your payment…".
7. `!isActionable` fallback - yellow "This estimate is currently not available for action."
8. else `null`.

### 7.6 Signature pad

`react-signature-canvas` (`SignatureCanvas`), refs `sigCanvasRef` + `sigContainerRef`.
A `ResizeObserver` on the container (lines 221-240) recomputes the canvas pixel buffer as
`floor(width * devicePixelRatio) x floor(128 * devicePixelRatio)` and **resets `sigDrawn` to false
on every resize**. CSS size is pinned to `width:100%, height:128px`. `onEnd` sets `sigDrawn=true`.
"Clear" calls `sigCanvasRef.current?.clear()` and `setSigDrawn(false)`.
`handleApprove` re-checks `sigCanvasRef.current?.isEmpty()` and bails with
`'Please draw your signature before approving.'`.

This library is on the Phase-0 React 19 compat watch list (`react-signature-canvas@^1.1.0-alpha.2`)
and it is the single highest-risk dependency in this module.

### 7.7 Payment method selection

`collapseCardMethods(methods)` (lines 135-148): `CARD` and `EXTERNAL_CARD` collapse to ONE entry;
`CARD` wins when both are present. Labels: `CARD`/`EXTERNAL_CARD` -> `Credit/Debit Card`,
`CHECK` -> `Check`, `BANK_TRANSFER` -> `Bank Transfer (ACH)`, `CASH` -> `Cash`.
Icons: `CreditCard`, `Banknote`, `Landmark`, `Wallet`.

`handlePaymentMethodSelect(method)`:
- `CARD` -> `handleApprove('CARD')` immediately (Stripe path; response carries `checkout_url`).
- anything else -> `setSelectedMethod(method)`, which swaps the card for an instructions panel.

Instructions panel: a "Back to payment methods" button, heading
`Pay by {label} — {formatCurrency(depositAmount)}`, then either the `EXTERNAL_CARD` "call our
office{ at org.phone}" block, or `paymentInstructions[INSTRUCTION_KEYS[method]]` rendered
`whitespace-pre-wrap`, then `Confirm & Approve` -> `handleApprove(selectedMethod)`.

Method-list extras: for `CARD` the button amount is `depositAmount + surchargeAmount` with a
sub-line "includes $X processing fee"; when `CARD` is in `availableMethods` an amber warning shows
`Credit card payments include a {(surchargeRate*100).toFixed(1)}% processing fee.`

### 7.8 What a customer can actually do

Approve (with signature, plus terms checkbox when the org has `estimate_terms`), pick a deposit
payment method, get redirected to Stripe Checkout, decline (with a confirm dialog), download the
PDF, and open the org website link. Nothing else - there is no login, no account, no edit.

### 7.9 Loading / empty / error

- Loading: full-screen `Loader2 animate-spin` on `bg-slate-50`.
- Fatal error (`error && !estimate`): centred Card, `XCircle`, `Unavailable`, `{error}`.
- Non-fatal error (`error && estimate`): red banner Card above the document.
- `!estimate` after loading and no error: `return null` - a blank white page.

### 7.10 Selector surface

No `data-testid`. Live e2e dependencies (`frontend/e2e/specs/redesign/03-public-deposit.spec.ts`,
`02-public.spec.ts`):

```
page.locator('canvas')                                        // the signature pad
getByText('Select Payment Method')
getByRole('button', { name: /pay with credit\/debit card/i })
getByRole('button', { name: /pay by check/i })
getByRole('checkbox', { name: /i agree to the terms/i })
getByRole('button', { name: /confirm & approve/i })
getByRole('button', { name: /approve estimate/i })
getByText('Deposit Pending')
getByText(/deposit required/i)
getByText(/please sign above( to approve)?/i)
getByText(estimateNumber, { exact:false })                    // rendered by EstimateDocumentView
```

`03-public-deposit.spec.ts:44` explicitly states its locators were read off `PublicEstimatePage.tsx`.
Load-bearing strings that must survive verbatim: `Select Payment Method`, `Confirm & Approve`,
`Approve Estimate`, `Decline Estimate`, `Deposit Pending`, `Deposit required:`,
`Please sign above to approve`, `Please sign above to proceed to payment`,
`I agree to the terms and conditions`, `Pay with Credit/Debit Card`, `Pay by Check`,
and the `<canvas>` element being the only canvas on the page.

### 7.11 Cross-module: `EstimateDocumentView`

`PublicEstimatePage.tsx:613-627` passes: `estimateNumber, customerName (via
customerDisplayName(estimate.customer ?? estimate.lead?.customer, '')), companyName, scopeNotes,
lineItems, subtotal, taxRate, taxAmount, totalAmount, discountType, discountValue, discountName,
discountAmount` - all numerics wrapped in `Number(...)`.

The same component is rendered by `EstimateDetailPage.tsx:1064` (the authed "customer-facing
preview") and `EstimateFormPage.tsx:710` (live form preview), and
`frontend/src/__tests__/estimate-detail-preview.test.tsx` asserts its layout.
**Rule for the v2 build: do not restyle `EstimateDocumentView` inside module 13.** If the estimates
module (module 4) restyles it, the public page inherits the change for free - which is correct, the
customer document and the internal preview are meant to be identical. Coordinate, do not fork.

Internals worth knowing: it renders `taxRate` as `(taxRate * 100).toFixed(2)%` - i.e. it expects a
FRACTION, and `PublicEstimatePage` passes `Number(estimate.tax_rate)` straight through. It also
splits `description` on the first `\n` into name + detail, and picks a `Package` or `Wrench` icon
by `item_type === 'MATERIAL'`. It uses raw `text-gray-*` / `bg-orange-100` / `bg-blue-100` Tailwind
palette classes today, which violates the CLAUDE.md tokens-only boundary - a v2 rewrite of this
component would be a genuine improvement but is a module-4 decision.

---

## 8. `/p/invoices/:id` - PublicInvoicePage

### 8.1 Token model

Identical shape to the estimate page: `id` from path, `token` + `payment` from the query, bare
`fetch()`, no auth header. Missing token -> `setError('Invalid link — token missing')`.
Backend (`backend/src/routes/invoice.routes.ts:15-16`), both before `authenticate`:
`GET /:id/public` (`unscopedRequest`, `publicReadLimiter`) and
`POST /:id/public/checkout` (`unscopedRequest`, `publicActionLimiter`).

### 8.2 API calls

| Trigger | Call | Response consumed |
|---|---|---|
| mount | `GET /api/invoices/:id/public?token=` | `data.invoice`, `data.organization`, `data.available_payment_methods`, `data.payment_instructions`, `data.surcharge_rate ?? 0.035` |
| "Pay $X by Card" | `POST /api/invoices/:id/public/checkout?token=` | `data.checkout_url` -> `window.location.href = ...` |

Fetch failure -> `setError('This invoice is no longer available.')`. Checkout failure -> throw
`data.error || 'Failed to create checkout session'`, shown in the non-fatal red banner.
**Unlike the estimate page, `?payment=success|cancelled` does NOT refetch** - it only sets the
banner and strips the query param. So the amount due can be stale right after a successful
payment; the copy says "It may take a moment to process."

### 8.3 Derived state

```
amountDue      = Number(invoice.amount_due)
surchargeAmount= amountDue * surchargeRate
cardTotal      = amountDue + surchargeAmount
isVoided       = status === 'VOIDED'
isPaid         = status === 'PAID'
isPayable      = status === 'SENT' || status === 'PARTIAL'
payer          = invoice.customer ?? invoice.job?.customer ?? null      // job-less DEPOSIT support
location       = invoice.job?.service_location ?? null
estimateLineItems = invoice.job?.estimate?.line_items ?? []
jobCharges        = invoice.job?.charges ?? []
ownLineItems      = invoice.line_items ?? []
```

`isVoided` short-circuits the whole page (lines 257-267): a centred Card, `XCircle`,
`Invoice Voided`, "This invoice has been voided. Please contact us for assistance." Nothing else
renders.

### 8.4 Component tree

```
div.fixed.inset-0.overflow-y-auto            -- NOTE: no org branding bar (unlike the estimate page)
└─ div.max-w-2xl.mx-auto
   ├─ {error && invoice && Card.bg-red-50}
   ├─ {paymentBanner && Card green|amber}
   ├─ renderInvoiceDocument()                -- Card
   │  ├─ header: "INVOICE" / invoice_number / "Estimate E… · Job J…" when job.estimate exists
   │  ├─ right column: Sent / Due / Paid dates (toLocaleDateString)
   │  ├─ Bill To (payer name/email/formatPhone(phone)) | Service Address or "Type: Deposit|Invoice"
   │  ├─ renderLineItemsTable()              -- LOCAL <table>, three row groups
   │  ├─ renderTotals()
   │  └─ {payments.length > 0 && "Payment History" rows}
   ├─ {isPaid && Card green "Paid in Full" + paid_at}
   ├─ {isPayable && due_date < now && Card amber "This invoice was due on …"}
   └─ {isPayable && amountDue > 0 && availableMethods.length > 0 && Card "Payment Options"}
```

`renderLineItemsTable()` (lines 271-355) - a raw `<table class="w-full text-sm">` in an
`overflow-x-auto` wrapper, columns `Description | Qty | Unit Price | Total`. Three row groups, each
badged: estimate items get a slate `Estimate` pill, job charges an amber `Job` pill, and the
invoice's own `line_items` (job-less DEPOSIT invoices only, guarded by `!invoice.job`) get no pill.
Each description can carry a `Taxable` sub-label. All three empty -> italic "No line items".

`renderTotals()` (lines 357-422): Subtotal, optional Discount (with `estimate.discount_name` in
parentheses, green minus), optional Tax (with `estimate.tax_rate`% in parentheses), Total (top
border), optional Deposit credit (green minus), optional Payments received (green minus), then
**Amount Due** in bold with a `border-t-2` rule.

### 8.5 Payment Options card

Same `collapseCardMethods` helper, but different labels (`CARD`/`EXTERNAL_CARD` -> `Credit Card`,
`BANK_TRANSFER` -> `Bank Transfer`, no "(ACH)").

- `CARD` renders **inline** as a bordered panel with a breakdown (Invoice balance / Card processing
  fee (N.N%) / Total charged) and a `Pay {cardTotal} by Card` button -> `handleCheckout()`,
  `disabled={checkoutLoading}`, spinner swap on the icon.
- Every other method renders a click-to-reveal outline Button -> `setSelectedMethod(method)`, which
  swaps the card body for the instructions panel: "Back to payment methods" button, heading
  `Pay by {label} — {formatCurrency(amountDue)}`, the `EXTERNAL_CARD` call-us block or
  `paymentInstructions[...]`, and the closing line "Once we receive your payment, your invoice will
  be updated automatically."

Note the asymmetry with the estimate page: here a non-card method has **no confirm action at all** -
it is information only. On the estimate page the equivalent panel ends in `Confirm & Approve`.

### 8.6 What a customer can do

View the invoice document and payment history, pay by card via Stripe Checkout, or read the
instructions for check / ACH / cash / call-us-card. No signature, no approve, no decline, no PDF
download link on this page.

### 8.7 Loading / empty / error

Loading spinner, fatal `Unavailable` Card, non-fatal red banner, `!invoice -> return null`, plus
the voided full-page state. Payment Options is hidden entirely when `!isPayable`, `amountDue <= 0`,
or `availableMethods` is empty.

### 8.8 Selector surface

No testids. e2e (`02-public.spec.ts:108-160`):

```
page.goto('/p/invoices/${id}?token=${token}')
getByText(invoiceNumber, { exact:false })
getByText('Payment Options')
getByText('Amount Due')
getByText(amountText)                                          // formatted currency string
getByRole('button', { name: /pay by (check|cash)/i })
```

Load-bearing strings: `Payment Options`, `Amount Due`, `Pay by Check` / `Pay by Cash`,
`INVOICE`, the invoice number, and the `formatCurrency` output format.

---

## 9. `NotAuthorizedPage`

28 lines, no route, no props, no data. Renders `min-h-[60vh]` centred: a `rounded-ic
bg-primary-subtle` circle with `ShieldOff`, `h1` "You don't have access to this page" (uses
`&rsquo;`), a `p` "If you think you should, ask an administrator to update your permissions.",
and `<Button asChild variant="default"><Link to="/">Go back</Link></Button>`.

Rendered only by `ProtectedRoute` when `fallback` is set and the role check fails - so it appears
INSIDE `AppLayout` (sidebar + header still present). Three call sites: `/invoices/new`,
`/reports` + `/reports/:slug`, `/users` + `/settings/organization`.

`rounded-ic` is a project-specific radius token; a v2 rebuild must keep using tokens, not a raw
`rounded-full`.

---

## 10. `/design-system` - DesignSystemPage

718 lines. Explicitly documented at the top of the file as "a standalone, PUBLIC, query-free page
that renders the WHOLE design system in one screen for visual review / screenshotting… Fires no
API / network queries so it renders without auth or a backend."

All data is static module-level constants (`demoJobRows`, `demoJobColumns`, `waveData`,
`capsuleData`, …). Sections rendered, in order (from the `<Section title=…>` calls):

Color Tokens · Typography · Radius & Shadow · Buttons · Badges · Table ·
DataTable - pinned columns (list pages) · Card headers (SectionCard) · Tabs · KPI Cards ·
Chart Primitives (ChartCard wrapping WaveAreaChart, CapsuleBar, StackedBars, HorizontalBars,
ProgressDonut, SegmentedDonut, GaugeArc, Funnel, SeverityBars, Sparkline).

It imports `chartPalette` and `token` from `@/design-system`, and `formatCurrency` /
`formatCurrencyWhole` from `@/lib/utils`. It is the page most likely to need rewriting rather than
re-skinning, because its entire purpose is to display the OLD design system. Recommendation for the
v2 build: leave `/design-system` untouched and add a separate v2 kitchen-sink page rather than
porting this one - a v2 version of it would be documenting a different system.

Interactive elements: only the `Tabs` demo and the `DataTable` demo's own column-pinning UI. No
navigation, no forms, no API.

---

## 11. Open questions

1. **AuthCallbackPage has no timeout.** If Supabase never emits a session (bad OAuth config,
   user closes the consent screen and lands back), the page shows `Signing you in…` indefinitely
   and the `onAuthStateChange` subscription is never unsubscribed (the cleanup only runs inside
   the callback). Deliberate or a latent bug? Not changing it in a presentation-only port.
2. **AcceptInvitePage ignores `LoginResult`.** `await login(email, password)` at line 60 discards
   the discriminated result; with MFA enabled the page navigates to `/` without a session. Needs a
   product answer before any v2 page could reasonably differ.
3. **PublicInvoicePage does not refetch after `?payment=success`** while PublicEstimatePage does
   (`fetchEstimate()` at line 209). Intentional asymmetry, or an oversight? The v2 build must
   reproduce it as-is either way.
4. **PublicInvoicePage has no org branding bar and no "Download PDF" link**, while
   PublicEstimatePage has both. `GET /api/invoices/:id/public/pdf` does not exist in
   `invoice.routes.ts`, so the missing PDF link is at least consistent with the backend. The
   missing branding bar is unexplained - `data.organization` IS fetched and stored, and only
   `organization.phone` is used.
5. **The `error` state on both public pages is never cleared.** Once `setError` fires from a failed
   approve/checkout, the red banner persists for the life of the page even after a successful retry.
6. **`useSearchParams` + `?payment=` effect has an exhaustive-deps eslint-disable** on both public
   pages (estimate line 218, invoice line 185). Any v2 refactor of these effects risks changing
   run-count behaviour.
7. **Sentry route naming.** `SentryRoutes = Sentry.withSentryReactRouterV7Routing(Routes)` names
   transactions by matched pattern, so `/p/estimates/:id` is already grouped. Adding a `/v2` prefix
   block will create parallel transaction names - worth telling whoever watches Sentry.
8. **Live-site crawl was not performed** (browser tools were out of scope for this mapping pass).
   Everything above is read from source plus the committed Playwright specs. Behaviour that only
   manifests against the deployed app - Stripe Checkout redirect round-trip, real
   `payment_instructions` content, actual `surcharge_rate` from the org - is unverified.

---

## 12. Risks for the v2 build

| Risk | Why it matters |
|---|---|
| `react-signature-canvas@^1.1.0-alpha.2` on React 19 | It is an alpha, and it is the ONLY way to approve an estimate. If it breaks, the customer-facing approve flow is dead. Phase 0 must prove it before this module starts. |
| No `data-testid` anywhere in the module | Every e2e assertion is text- or role-based. Any copy change (`Sign In`, `Payment Options`, `Approve Estimate`, `Amount Due`, `Select Payment Method`, `Confirm & Approve`) silently breaks a spec. The v2 pages should ADD testids rather than rely on copy. |
| `#email` / `#password` on LoginPage | `e2e/global-setup.ts` uses raw `page.locator('#email')`. Losing those ids breaks the login helper and therefore EVERY authed spec in the suite, including all the other modules' Phase 3 gates. |
| No `TooltipProvider` outside AppLayout | Kit components that assume a tooltip context will throw on these six routes. Each v2 public page needs its own provider. |
| `EstimateDocumentView` is shared three ways | A restyle inside module 13 changes the authed estimate detail and form previews and breaks `estimate-detail-preview.test.tsx`. Must be coordinated with module 4. |
| No org formatting on public pages | `formatCurrency` falls back to defaults because `setOrgFormattingPrefs` never runs. Do not "fix" this by adding `useOrganization()` - it is an authed call. |
| `fixed inset-0` shells | Both public pages take over the viewport. Kit layout primitives that assume a scroll parent will fight this. |
| Payment copy is compliance-adjacent | Surcharge percentages, "call our office", terms acceptance and the deposit language are customer-facing money copy. Treat every string as load-bearing; change none of it. |
