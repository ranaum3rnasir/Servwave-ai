# Auth & Public - components with no kit equivalent

Module 13. Branch `refactor/ui-kit-13-auth-public`.

Pages rebuilt under `frontend/src/pages/v2/auth-public/`: `LoginPage.tsx`,
`AuthCallbackPage.tsx`, `AcceptInvitePage.tsx`, `PublicEstimatePage.tsx`,
`PublicInvoicePage.tsx`, `UpgradePage.tsx`, `NotAuthorizedPage.tsx`, plus three shared pieces in
`components/` (`brandLockup.tsx`, `authPanel.tsx`, `publicShell.tsx`) and a module smoke test in
`__tests__/authPublic.test.tsx`.

Registered by `pages/v2/routes/auth-public.paths.ts` + `auth-public.routes.tsx`.

The import checklist is every `@/components/...` import across the seven legacy pages - 20 rows,
all accounted for in the Replaced table below.

## What is different about this module

1. **Five of the seven pages render OUTSIDE any layout.** `/login`, `/auth/callback`,
   `/accept-invite`, `/p/estimates/:id` and `/p/invoices/:id` sit above `ProtectedRoute` and above
   `AppLayout` in `App.tsx`, and they are reproduced the same way - NOT nested under `V2AppLayout`.
   Only `/upgrade` (and the unrouted not-authorized surface) live inside the shell.
2. **The two public pages are unauthenticated.** Every request is a bare `fetch()` with `?token=`;
   no axios, no Bearer header, no Supabase session. Nothing in `pages/v2/auth-public/` imports
   `useAuthStore`, `useAppAbility`, `useOrganization` or `lib/entitlements` on a public path, and
   `publicShell.tsx` carries that rule in its header so the next editor sees it.
3. **`formatCurrency` deliberately uses its default currency on the public pages**, because
   `setOrgFormattingPrefs` only runs inside an app layout. Not fixed - the fix would be an authed
   call from a page a homeowner is looking at.

## Gaps

| Old component | Used in | What it does | Kit's nearest thing | Why it is not enough | Rec |
|---|---|---|---|---|---|
| `ui/action-link` (`ActionLink`) | public estimate (Download PDF, org website), public invoice (Download PDF), accept-invite (ToS + Privacy), upgrade (mailto CTA) | a control-shaped element that navigates: `link` and `outline` cells over a real `<a>`, with `asChild` polymorphism | none | the kit ships no link primitive of any kind. `Button variant="link"` is a 40px inline-flex control, not inline text, and wrapping a raw `<a>` is blocked twice over: the raw-`<a>` ratchet is AT ITS FLOOR (44/44) and `Button asChild` is broken (row below) | BUILD |
| `ui/thumbnail` (`Thumbnail`) | public estimate (org logo, customer signature) | a bordered/rounded `<img>` with a size scale | none (`ui-kit/components/ui/avatar` renders an img, but only as a circular initials-fallback avatar) | the kit ships no image primitive, and the raw-`<img>` ratchet is AT ITS FLOOR (38/38), so a page cannot author its own `<img>` either. Every class passed here is layout, so Thumbnail still owns its own appearance | BUILD |
| `estimates/EstimateDocumentView` | public estimate | the customer-facing estimate document: line-item cards, per-line discounts, totals block | none | shared three ways (this page, the authed estimate workspace preview, and `src/__tests__/estimate-detail-preview.test.tsx`). Restyling it from module 13 would change two other surfaces and break a committed test. Rendered unchanged, exactly as its own behaviour map instructs | KEEP (module 4 owns it) |
| `brand/ServWaveMark`, `brand/GoogleIcon` | login, accept-invite | the ServWave wave mark; the Google "G" | `layout/nav/topBar`'s `TopBarBrand` | `TopBarBrand` is shell chrome and drags the topbar's geometry with it; there is no standalone brand mark. `GoogleIcon`'s four literal hexes are a documented trademark exemption and must never be tokenised | KEEP |
| `react-signature-canvas` | public estimate | the signature pad the whole approve flow depends on | none | the kit ships no drawing surface. Kept verbatim, including the `ResizeObserver` that re-syncs the pixel buffer and resets `sigDrawn` | KEEP |
| Kit `Card`: no `tone` | both public pages (13 banner sites) | legacy `Card tone="success\|warning\|danger\|info\|neutral"` paints tinted status bands | `ui-kit/components/ui/card` | the kit's Card has one surface and no tone axis, and `Card`'s appearance-override ceiling in `component-api-guard` is AT ITS FLOOR (2/2), so a `className` tint is not available either. Worked around with `publicShell.tsx`'s `PublicNotice`, a plain tinted div - the same shape the v2 invoices and estimates pages already use | BUILD |
| Kit `Card`: no `padding` | every card on both public pages, login, accept-invite, upgrade | legacy `Card padding="sm\|lg"` | `ui-kit/components/ui/card` | the kit expects `CardHeader`/`CardContent` to supply the inset, and `CardContent` (unlike `Card`) is not a ratcheted primitive, so padding rides there. Not a real gap so much as a different authoring model - recorded because every call site changed shape | KEEP |
| Kit `Button`: `asChild` is broken | would have been used for the "Go back" link and the mailto CTA | render the button's styling onto a router `<Link>` or an `<a>` | `ui-kit/components/ui/button` | `Button` ALWAYS renders two children (`{isLoading ? <Loader2/> : null}` then `{children}`), so with `asChild` Radix `Slot` throws **"Slot failed to slot onto its children. Expected a single React element child or `Slottable`."** Caught by this module's smoke test. The one-line kit fix is to wrap `{children}` in `<Slottable>`; not done here because `ui-kit/` is shared. **Two already-merged customers-module sites hit the same defect** - see "Observed but not fixed" | BUILD (fix in the kit) |
| Kit `Button`: no `tone` axis | public estimate ("Decline Estimate" was `outline`+`danger`, "Approve Estimate" was `solid`+`business`) | the app's Button has a variant x tone grid | `ui-kit/components/ui/button` | the kit has six flat variants and no tone. `destructive` is a solid red, too loud for a secondary Decline sitting beside Approve, so both Decline controls are plain `outline` and Approve is the kit default. Disclosed visual delta, no behaviour change | BUILD |
| Kit `TableCell`: no `align` / `weight` | public invoice line-item table (Qty / Unit Price / Total) | right-aligned, optionally bold numeric cells | `ui-kit/components/ui/table` | the kit's `TableCell` has only a `padding` prop, and the `TableCell` appearance ceiling is AT ITS FLOOR (3/3), so `className="text-right"` would raise a ratchet. Worked around with a local `NumCell` that puts the alignment on an inner span | BUILD |
| `ui/heading` (`Heading`) | all seven pages | `level` + `scale` + `weight` + `tone` typography primitive | none | the kit expects utility classes; a raw `<h1>`-`<h6>` is also governed (raw-tag ratchet, 58/67). Every heading is `<p role="heading" aria-level={n}>`, the pattern the customers/invoices/leads v2 modules already established. The accessible name is identical, which is what `e2e/global-setup.ts` matches on | DROP |
| `patterns/FormField` | login, accept-invite | label + control + error, wired by id | `ui-kit/components/form/formField` | the kit's FormField is a react-hook-form `Controller` wrapper that GENERATES its own control id (`${useId()}-control`). Login cannot use it: `e2e/global-setup.ts` locates the fields with raw `page.locator('#email')` / `#password`, so the ids are load-bearing and must be authored. Used `Label` + `Input` + an explicit `htmlFor`/`id` pair instead | KEEP (kit FormField is fine elsewhere) |
| `ProtectedRoute` cannot render a v2 not-authorized page | every v2 route with `fallback` | the 403 surface for an in-app deep link | - | `components/ProtectedRoute.tsx` imports `pages/NotAuthorizedPage` directly. Pointing it at the v2 component means editing a file every module branch shares. **Escalated.** The v2 page is built and routed at `/v2/not-authorized` so it is reviewable and ready for cutover | escalated |
| `lib/auth-listener.ts` pins the OAuth skip to the exact pathname `/auth/callback` | `/v2/auth/callback` | stops the global listener calling `checkAuth()` in parallel with the finalize | - | `OAUTH_CALLBACK_PATH === window.location.pathname`. A `/v2`-prefixed pathname does not match, so the listener would race `finalizeOAuthLogin()` and `GET /api/auth/me` would 401 the not-yet-finalized Google identity straight back out. Shared file, may not be edited. **Escalated**; `/auth/callback` is therefore NOT registered in `auth-public.paths.ts` and the legacy path keeps serving the real OAuth return | escalated |

## Replaced (the audit trail)

Every `@/components/...` import across the seven legacy pages, and what stands in for it.

### `pages/LoginPage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `brand/ServWaveMark` | kept, wrapped in `pages/v2/auth-public/components/brandLockup` | the mark itself is unchanged; the lockup markup was copy-pasted three times across two legacy pages and is now one component |
| `brand/GoogleIcon` | kept | trademark exemption, see the gap row |
| `ui/button` | `ui-kit/components/ui/button` | submit, Verify, Resend (`variant="link"`), Google (`variant="outline"`) |
| `ui/heading` | `<p role="heading" aria-level={2}>` | accessible name `Sign In` / `Verify it's you` preserved verbatim, U+2019 included |
| `patterns/FormField` | `ui-kit/components/ui/label` + `ui-kit/components/ui/input` | `id="email"`, `id="password"`, `id="mfa-code"` and their `htmlFor` pairs preserved; field errors are a `<p className="text-destructive text-xs">` under the control, as before |

### `pages/AuthCallbackPage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| (none - the page imports only `lib/*` and the store) | `ui-kit/components/ui/spinner` added beside the `Signing you in…` text | the flow (ran-once ref, `getSession` then `onAuthStateChange`, `finalizeOAuthLogin`, sign-out-and-bounce on throw) is byte-for-byte the legacy flow |

### `pages/AcceptInvitePage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `brand/ServWaveMark` | `components/brandLockup` | |
| `brand/GoogleIcon` | kept | |
| `ui/button` | `ui-kit/components/ui/button` | |
| `ui/checkbox` | `ui-kit/components/ui/checkbox` | the ToS/Privacy consent gate; `aria-label` preserved and an explicit `id`/`htmlFor` pair added |
| `ui/heading` | `<p role="heading" aria-level={2}>` | `Welcome{, firstName}` |
| `patterns/FormField` | kit `Label` + `Input` | `id="password"`, `id="confirm"` preserved |
| (the two ToS/Privacy anchors) | `ui/action-link` (`ActionLink`) | gap row - raw `<a>` is at its ratchet floor |

### `pages/NotAuthorizedPage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/button` | `ui-kit/components/ui/button` | `asChild` + router `<Link>` became an `onClick` + `navigate('/v2')`; the kit's Button cannot take `asChild` (gap row) |
| `ui/heading` | `<p role="heading" aria-level={1}>` | copy unchanged, `&rsquo;` included |
| (`rounded-ic bg-primary-subtle` icon chip) | `bg-brand-subtle text-brand ... rounded-xl` | kit token equivalents |

### `pages/UpgradePage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/button` | `ui-kit/components/ui/button` (Back to dashboard) + `ui/action-link` `variant="outline"` (the mailto CTA) | the CTA has to stay a real anchor with a `mailto:` href; `Button asChild` is unusable |
| `ui/heading` | `<p role="heading" aria-level={1}>` | |
| `lib/entitlements` (`useOrgPlan`, `catalogEntry`, `PLAN_LABELS`) | imported unchanged | including the `||` (not `??`) that keeps an empty `required_plan` param from beating the catalog |

### `pages/PublicEstimatePage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/card` (plain) | `ui-kit/components/ui/card` via `publicShell`'s `PublicCard` | padding on `CardContent`, never on `Card` |
| `ui/card` (`tone=` banners) | `publicShell`'s `PublicNotice` | gap row; tones map to the kit's `status-{green,amber,red,blue}-subtle/-emphasis` and `muted` |
| `ui/button` | `ui-kit/components/ui/button` | including the payment-method rows, Clear, Approve/Decline and the PENDING "Complete deposit payment" CTA |
| `ui/checkbox` | `ui-kit/components/ui/checkbox` | the terms gate; `I agree to the terms and conditions` is now a real `<Label htmlFor>` |
| `ui/confirm-dialog` (`ConfirmDialog`) | `ui-kit/components/ui/confirmDialog` | prop rename only: `variant="destructive"` -> `destructive`, `isLoading` -> `isPending`. `Go Back` / `Yes, Decline` labels unchanged |
| `ui/heading` | `<p role="heading">` via `PublicCardTitle` | `Select Payment Method` and `Terms & Conditions` keep their accessible names |
| `estimates/EstimateDocumentView` | kept, unchanged | gap row |
| (org logo `<img>`, signature `<img>`) | `ui/thumbnail` (`Thumbnail`) | gap row |
| (Download PDF `<a>`, org website `<a>`) | `ui/action-link` (`ActionLink`) | gap row. The PDF link is `variant="outline"` so it stays legible on an arbitrary org brand colour, where the legacy white-on-fill treatment assumed a dark one |
| `lucide-react` icons, `lib/utils`, `lib/safe-href`, `lib/customer-name`, `lib/branding`, `constants/estimateStatus` | imported unchanged | `ESTIMATE_STATUS.WON` / `.ARCHIVED` are still read from the constant, never as literals |

### `pages/PublicInvoicePage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/card` (plain) | `ui-kit/components/ui/card` via `PublicCard` | |
| `ui/card` (`tone=` banners) | `PublicNotice` | |
| `ui/button` | `ui-kit/components/ui/button` | |
| `ui/heading` | `PublicCardTitle` / `<p role="heading" aria-level={1}>` | `INVOICE`, `Payment Options` and `Pay by Card` keep their accessible names |
| `ui/action-link` | kept | the Download PDF link was already an ActionLink; gap row |
| (local raw `<table>` in `renderLineItemsTable`) | `ui-kit/components/ui/table` (`Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell`) | the raw-`<table>` ratchet is at its floor; alignment moved to a local `NumCell` because `TableCell` has no `align` prop |
| (inline `Estimate` / `Job` pill spans) | `ui-kit/components/ui/badge` (`softNeutral` / `softAmber`) | |
| (inline `Loader2` spinners) | `Spinner` via `PublicLoading`, and `Button isLoading` | |

## Behaviour deltas (not gaps, but not parity either)

| What | Legacy | v2 | Why |
|---|---|---|---|
| `/auth/callback` under `VITE_UI_V2=true` | n/a | still renders the LEGACY page; the v2 page is routed at `/v2/auth/callback` but not registered for the flag redirect | `lib/auth-listener.ts` pins its race-guard to the exact pathname. Escalated - see the gap row |
| `NotAuthorized` under a failed v2 role check | legacy page inside `AppLayout` | legacy page inside `V2AppLayout` | `ProtectedRoute` imports the legacy page directly. Escalated |
| "Go back" on not-authorized | a real `<a href="/">` (middle-click opened a tab) | a `<button>` calling `navigate('/v2')` | `Button asChild` throws in this kit |
| Decline buttons | `outline` + `danger` tone | plain `outline` | the kit's Button has no tone axis; `destructive` is a solid red and too loud for a secondary action |
| Approve Estimate | `solid` + `business` (sage) | the kit's default solid | same reason |
| Login / invite card elevation | `shadow-xl ring-1 ring-border` | the kit Card's own `shadow-sm` + border | the layering guard exists to stop a call site restating a component's elevation |
| Upgrade CTA | solid primary button | `ActionLink variant="outline"` (bordered pill) with the Back action demoted to `ghost` so the hierarchy survives | the CTA must stay a real `mailto:` anchor and `Button asChild` is unusable |
| Em/en dashes in copy | six places carry a U+2014 em dash, a U+2013 en dash or a U+2212 minus: the `Invalid link ... token missing` error, the `Pay by {method} ... {amount}` instructions heading, the `Approved ... Deposit Pending` banner, the `5...30 technician shops` value prop, the negative-amount rows in the invoice totals, and the empty-value placeholders | the same strings with plain hyphens | CLAUDE.md forbids em and en dashes in anything this branch authors. Checked against every committed assertion first: the e2e specs match `Deposit Pending`, `Pay by Check`, `Payment Options`, `Amount Due`, `Select Payment Method`, `Confirm & Approve` and `Deposit required:` as substrings, and the unit tests match `isn't accepting card payments right now` as a prefix regex - none of them span a dash |
| `role="alert"` on the auth error banner | absent | added | neither legacy auth page announced its error, so a screen-reader user submitted and heard nothing. Additive, no visible change |

## Corrections to the behaviour map (the code won)

`md_files/specs/ui-redesign/auth-public-behavior-map.md` is dated 2026-07-29 and has drifted.
Every item below was read from the file it names.

| Map says | Actually |
|---|---|
| §0/§10: this module owns `/design-system` -> `pages/design-system/DesignSystemPage.tsx`, 718 lines, lazy at `App.tsx:11` | **The directory does not exist and the route is gone.** `grep DesignSystemPage App.tsx` returns nothing. A whole section of the map describes a deleted page |
| §0: the module's pages are the six above | `pages/UpgradePage.tsx` (`/upgrade`) also belongs here and the map never mentions it. It is a `ProtectedRoute` with NO `allowedRoles` inside `AppLayout` - deliberately reachable by TECHNICIAN, because the 402 interceptor is global |
| §0: LoginPage 295 lines, hand-rolled inputs, inline 4-path Google SVG | 278 lines, built from `Heading`, `patterns/FormField` and `Button`, with the SVG extracted to `components/brand/GoogleIcon.tsx` |
| §0/§6: AcceptInvitePage 191 lines; `acceptInvite(token, password)`; no consent UI | 238 lines. There is a mandatory Terms-of-Service/Privacy checkbox, `acceptInvite(token, password, acceptedTerms)`, a third validation rule, a `recordInviteConsent(token)` call on the Google path, and `loginWithGoogle(email)` pins the OAuth request to the invited address with `login_hint` + `prompt=select_account` |
| §1: "No `TooltipProvider`" outside AppLayout, listed as a risk for the v2 build | `App.tsx:287` mounts `KitTooltipProvider` around `BrowserRouter`, so every route - public ones included - has one. The risk does not exist |
| §2: `ProtectedRoute` wraps `children`; `fallback` consumers are `/invoices/new`, `/reports`, `/users` + `/settings/organization` | it is an `<Outlet/>` layout route. `/settings/organization` no longer exists (Settings is a nested layout and is not ADMIN-gated); `/automations*` is a fourth `fallback` consumer |
| §7.2/§7.7/§8.1: the API returns `surcharge_rate` (default `0.035`) and the pages derive `surchargeAmount = amount * rate`, `cardTotal` | both pages read `service_fee_preview`, an absolute server-computed amount. `surcharge_rate`, `surchargeAmount` and `cardTotal` do not appear in either file |
| §7.5: the PENDING banner reads "Deposit Pending" and stamps `approved_at` | it reads "Approved - Deposit Pending", stamps `signature_at` (because `approved_at` is only set at WON), adds a service-fee line, and carries a "Complete deposit payment" button for the CARD lane so a customer who closed the Stripe tab is not stranded |
| §7.2: approve/decline failures surface `data.error` | both pages now map a card-unavailable 400 to homeowner-safe copy and fall back to a generic message, so no raw backend string reaches the customer |
| §8.4/§11 OQ-4: PublicInvoicePage has no Download PDF link, and `GET /api/invoices/:id/public/pdf` does not exist | the page renders an `ActionLink` to exactly that endpoint |
| §8.5: the CARD option renders inline as a bordered panel with a breakdown and a `Pay {cardTotal} by Card` button | it is a two-step reveal: a `Pay {amountDue} by Card` button that selects CARD, then a breakdown panel with a Back link and the checkout button. `renderTotals` also carries a permanent "Service fee (card payments only)" row |
| §0: the only real cross-module shared component is `EstimateDocumentView` | still true, and confirmed independently: `PublicInvoicePage` does not import `LineItemsTable` |

## Observed but not fixed

| What | Where | Why it is out of scope |
|---|---|---|
| **The kit's `Button` cannot be used with `asChild` at all.** It always renders two children, so Radix `Slot` throws `Slot failed to slot onto its children`. Two already-merged sites will crash the moment their branch renders: `pages/v2/customers/components/detailTabs.tsx:387` and `pages/v2/customers/CustomerDetailPage.tsx:809`. The fix is one line in `ui-kit/components/ui/button.tsx` (wrap `{children}` in `<Slottable>`) | `frontend/src/ui-kit/components/ui/button.tsx` | `ui-kit/` is shared by all fourteen branches. **Escalated - this should be fixed on the integration branch before cutover** |
| `AcceptInvitePage` discards the `LoginResult` from `login()`. With email-OTP MFA on, the store resolves `{mfaRequired:true}` with no session and the page still navigates to `/`, which `ProtectedRoute` bounces to `/login` | both the legacy page and the v2 port | reproduced deliberately; the correct behaviour is a product question (map OQ-2) |
| `PublicInvoicePage` does not refetch after `?payment=success`, while `PublicEstimatePage` does. The amount due can be stale immediately after a successful payment | both pages | reproduced as-is (map OQ-3). Adding a refetch is a behaviour change |
| `PublicInvoicePage` has no org branding bar even though `data.organization` is fetched; only `name` and `phone` are used | `PublicInvoicePage` | reproduced (map OQ-4). Adding one is a design decision |
| The `error` state on both public pages is never cleared. Once a failed approve/checkout sets it, the red banner outlives a successful retry | both public pages | reproduced (map OQ-5) |
| `AuthCallbackPage` has no timeout and never unsubscribes its `onAuthStateChange` listener unless a session arrives. A user who abandons the Google consent screen sees `Signing you in…` forever | both the legacy page and the v2 port | reproduced (map OQ-1); a timeout is a behaviour change |
| `EstimateDocumentView` uses raw `text-gray-*` / `bg-orange-100` / `bg-blue-100` palette classes, which violates the tokens-only boundary | `components/estimates/EstimateDocumentView.tsx` | module 4 owns it; restyling it here changes the authed preview and breaks `estimate-detail-preview.test.tsx` |
| `pages/design-system/` was deleted but `md_files/specs/ui-redesign/auth-public-behavior-map.md` still devotes a section to it and lists it as a route | the behaviour map | documentation task |
| Adding a `/v2` prefix creates parallel Sentry transaction names for `/p/estimates/:id` and `/p/invoices/:id` | `SentryRoutes` in `App.tsx` | worth telling whoever watches Sentry (map OQ-7); not a code change this branch can make |
