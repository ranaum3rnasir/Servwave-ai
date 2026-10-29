# Go-Live Playbook — ALPHA CRM

**When to use this:** the day ALPHA CRM goes from internal dual-run to handling real customers (either internal company use or first external customer).
**Time required:** ~1 hour
**Steady-state cost after go-live:** $34/mo (Render prod + Render staging + Vercel Pro)
**Prerequisites:** Phase A setup complete (staging + prod infrastructure live), all of Phase A is verified working.

> **Live values as of 2026-08-10** (steps 1-5 below are done; the placeholders in them are
> historical). Production frontend is `app.servwave.com`, production API is **`api.servwave.com`**,
> whose Render origin is `alpha-crm-1.onrender.com`. **`alpha-crm-api.onrender.com`, named as the
> prod backend throughout the 2026-04-23 setup docs, is dead and 404s** - do not use it in a config
> value, a webhook URL or a probe. Staging remains `alpha-crm-test-env.onrender.com` /
> `servwave-demo.vercel.app`.

---

## The 11 Steps (in order)

### 1. Buy domain (~$15/yr)
Suggested registrars:
- **Cloudflare Registrar** — at-cost pricing, no markup, best value
- **Namecheap** — simple UX, slight markup
- Avoid GoDaddy (aggressive upsells)

Pick the domain and complete checkout. Example: `alphacrm.com`.

### 2. Point DNS records
In the registrar's DNS control panel, create:
- `CNAME` `app` → `cname.vercel-dns.com` (or the value Vercel shows)
- `CNAME` `api` → the URL Render shows for custom domains
- Do **not** set up `api-staging` and `staging` subdomains unless you also want staging on the real domain — optional, keep on `.vercel.app` / `.onrender.com` is fine

Wait ~5-10 min for DNS propagation.

### 3. Update `FRONTEND_URL` in Render prod
Render dashboard → the prod backend service (origin `alpha-crm-1.onrender.com`) → Environment →
```
FRONTEND_URL=https://app.yourdomain.com
```
Save → triggers redeploy.

### 4. Update `VITE_API_URL` in Vercel prod
Vercel dashboard → project → Settings → Environment Variables → Production →
```
VITE_API_URL=https://api.yourdomain.com
```
Redeploy the production branch.

### 5. Verify domain in Resend
Resend dashboard → Domains → Add Domain → `yourdomain.com` → copy DNS records → paste into registrar → wait for verification (~15 min). Once verified, update code or Resend template settings to send `from: no-reply@yourdomain.com` instead of `onboarding@resend.dev`.

### 6. Flip Render prod plan Free → Starter
Render dashboard → the prod backend service (origin `alpha-crm-1.onrender.com`) → Settings → Plan → change to **Starter ($7/mo)** → confirm. No redeploy needed. **This eliminates the 15-min sleep behavior.**

**Also remove the UptimeRobot monitor for prod** (no longer needed since the service stays awake). Keep staging's monitor if you set one up.

### 7. Upgrade Vercel Hobby → Pro
Vercel dashboard → upgrade to Pro ($20/mo). This legitimizes commercial use per Vercel's ToS. Required the moment you have paying customers or sign business-use contracts.

### 8. Flip Stripe test → live mode
**Only do this when actually ready to charge real cards.** In Stripe dashboard:
- Toggle "View test data" → off
- Go to Developers → API keys → copy the live `sk_live_...` and `pk_live_...`
- Update in Render: `STRIPE_SECRET_KEY=sk_live_...`
- Update in Vercel: `VITE_STRIPE_PUBLISHABLE_KEY=pk_live_...`
- Redeploy both

### 9. Re-register Stripe webhook for prod
Stripe dashboard (live mode) → Developers → Webhooks → Add endpoint:
- URL: `https://api.yourdomain.com/api/webhooks/stripe`
- Events: same as staging webhook (at minimum: `checkout.session.completed`, `payment_intent.succeeded`, `charge.refunded`)
- Copy the new signing secret → update in Render prod: `STRIPE_WEBHOOK_SECRET=whsec_...`
- Delete any stale webhook endpoints from test mode if not needed

### 10. Create first prod admin user
From your local machine, pointed at prod DB. **Safest approach: temporarily create `backend/.env.prod-seed` with the prod values** (git-ignored), run the seed, then delete the file.

**PowerShell (Windows — your shell):**
```powershell
cd backend
Copy-Item .env .env.bak
Copy-Item .env.prod-seed .env  # temporarily swap
npm run seed
Copy-Item .env.bak .env        # restore
Remove-Item .env.prod-seed, .env.bak
```

**Bash (macOS/Linux alternative):**
```bash
cd backend
env $(cat .env.prod-seed | xargs) npm run seed
rm .env.prod-seed
```

**Fallback:** use the Supabase Auth dashboard to create the user, then manually insert a `users` row with `role=ADMIN` via Supabase SQL editor.

### 11. Internal announcement
Tell the team prod is live. Share:
- Prod URL: `https://app.yourdomain.com`
- First admin credentials (securely — Bitwarden / 1Password, not Slack)
- Staging remains available at `servwave-demo.vercel.app` for continued QA
- Any known-issues pulled forward from staging

---

## Post-Go-Live Checklist (first 48 hours)

- [ ] Prod responds on all routes (spot-check 5-10 pages)
- [ ] Auth works — admin can log in and create users
- [ ] Stripe test charge on staging still works (make sure nothing broke in the webhook handoff)
- [ ] Resend emails arrive from `@yourdomain.com` (verify SPF/DKIM in a Gmail inbox)
- [ ] UptimeRobot alerts working (manually stop staging to confirm notification fires)
- [ ] Log retention — check Render logs are accumulating correctly for prod service
- [ ] First backup point-in-time from Supabase (Free tier has no PITR; consider upgrading to Pro here if real data is being entered)

---

## Triggers to revisit infrastructure

Once prod is live, re-evaluate every ~3 months or whenever one of these hits:

| Signal | Action |
|---|---|
| Render prod service consistently >80% CPU or RAM | Upgrade to Standard ($25/mo, 2GB RAM) |
| Supabase Free 500MB storage ≥ 80% full | Upgrade to Pro ($25/mo) — also unlocks PITR backups |
| Supabase Free bandwidth >4GB/mo | Pro upgrade |
| Real customer data entering prod | Upgrade Supabase Pro for daily backups |
| Multiple developers, need PR CI | Add GitHub Actions for test runs on PR |
| 99.9% uptime not enough (SLA contract) | Consider AWS / multi-region |
| Compliance requirement (SOC 2, HIPAA) | Audit platform readiness, likely migrate |

---

## References

- Full architecture + decision log: [`2026-04-23-prod-env-setup-design.md`](./2026-04-23-prod-env-setup-design.md)
- Deployment workflow (push, merge, rollback): `.claude/skills/ship-changes/SKILL.md`
- Resend custom domain: https://resend.com/docs/dashboard/domains/introduction
- Stripe going live: https://stripe.com/docs/keys#going-live
- Supabase production checklist: https://supabase.com/docs/guides/deployment/going-into-prod
