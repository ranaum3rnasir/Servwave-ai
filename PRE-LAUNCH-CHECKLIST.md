# Pre-Launch Checklist

Things to complete before going live with real customers.

## Email (Resend)

- [ ] Register and verify a custom domain in Resend (e.g., `alphacrm.com`)
- [ ] Update `EMAIL_FROM` in production `.env` to use the verified domain (e.g., `noreply@alphacrm.com`)
- [ ] Replace the dev API key (`re_...`) with a production Resend API key
- [ ] Currently using `onboarding@resend.dev` as sender — must switch before launch

## Payments (Stripe)

- [x] Stripe integration production-ready in single-tenant mode (9C complete 2026-05-01)
- [ ] Production environment configured per [stripe-environment-config.md](md_files/plans/payments/stripe-environment-config.md)
- [ ] $1 production smoke transaction passes (see runbook §5)
- [ ] Connect Standard onboarding (9C2) — separate step

## Authentication & Security

- [ ] Rotate all Supabase keys for production environment
- [ ] Set strong `JWT_SECRET` if applicable
- [ ] Review rate limit thresholds for production traffic (currently 100 req/15min API, 5 attempts/15min auth)
- [ ] Enable HTTPS everywhere
- [ ] Audit CORS allowed origins for production domain
- [ ] Remove any hardcoded test credentials

## Database

- [ ] Run all pending Prisma migrations on production database
- [ ] Set up automated database backups
- [ ] Review and create necessary database indexes for production query patterns
- [ ] Seed production data (admin user, state tax rates, default app settings)

## Infrastructure

- [ ] Deploy backend to production host (Railway or similar)
- [ ] Deploy frontend to production host (Vercel or similar)
- [ ] Set `NODE_ENV=production` on backend
- [ ] Set `FRONTEND_URL` to production domain
- [ ] Configure production environment variables on all services
- [ ] Set up monitoring and error tracking (Sentry or similar)
- [ ] Set up logging aggregation for production

## Testing

- [ ] Run full backend test suite against production config
- [ ] Run E2E tests against staging environment
- [ ] Manual smoke test of all critical flows (lead → estimate → job → invoice → payment)
- [ ] Load test API endpoints

## Domain & DNS

- [ ] Register production domain
- [ ] Configure DNS for frontend, backend, and email sending (SPF, DKIM, DMARC for Resend)
- [ ] Set up SSL certificates
