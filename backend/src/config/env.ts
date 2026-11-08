import { z } from 'zod';
import dotenv from 'dotenv';
import { bridgeAgentIdsSchema, bridgeRingCallerSchema } from './bridgeRingCaller';

dotenv.config();

// .trim() everywhere: defends against a real-world bug we hit on staging where
// a paste into the Render/Vercel dashboard added a trailing space to JWT-shaped
// secrets, silently downgrading service-role calls to anon and triggering RLS
// denials. There is no legitimate case for whitespace in our env values.
const envSchema = z.object({
  // App
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  FRONTEND_URL: z.string().trim().default('http://localhost:5173'),
  CORS_ALLOWED_ORIGINS: z.string().trim().optional(),
  TAX_RATE: z.coerce.number().default(0.0875),

  // Build identity, injected by Render on every deploy — we never set these.
  // They are the ONLY way to answer "which commit is actually running?": the
  // platform has no version endpoint of its own, and a promotion that ships no
  // migration leaves nothing in the database to observe either. Absent locally
  // and in CI, which is why both are optional and /api/version reports null
  // rather than inventing a value.
  RENDER_GIT_COMMIT: z.string().trim().optional(),
  RENDER_GIT_BRANCH: z.string().trim().optional(),

  // Supabase
  DATABASE_URL: z.string().trim().url(),
  DIRECT_URL: z.string().trim().url().optional(),
  SUPABASE_URL: z.string().trim().url(),
  SUPABASE_ANON_KEY: z.string().trim().optional(), // only needed on frontend
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1),

  // JWT — unused at runtime (Supabase Auth issues + verifies JWTs).
  // JWT_ACCESS_EXPIRES_IN / JWT_REFRESH_EXPIRES_IN are documented in .env.example
  // but read from the Supabase Dashboard (Authentication → Sessions), not here.
  JWT_SECRET: z.string().trim().optional(),

  // Stripe — optional until Step 5
  STRIPE_SECRET_KEY: z.string().trim().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().trim().optional(),
  STRIPE_WEBHOOK_SECRET_CONNECT: z.string().trim().optional(),

  // CTM (CallTrackingMetrics) phone + SMS — optional until an org connects.
  // Agency Access/Secret keys reach every sub-account; values live ONLY in the
  // backend's Render dashboard (Stripe precedent - never in the repo).
  // CTM_WEBHOOK_TOKEN authenticates inbound CTM webhooks (?token=…, query-string
  // so the log redactor masks it); the webhook route fails CLOSED when unset.
  // BACKEND_PUBLIC_URL is this backend's own public origin, used to build the
  // weburl CTM calls back (FRONTEND_URL is the FE origin — wrong for this).
  CTM_ACCESS_KEY: z.string().trim().optional(),
  CTM_SECRET_KEY: z.string().trim().optional(),
  CTM_WEBHOOK_TOKEN: z.string().trim().optional(),
  // Dedicated secret for verifying CTM's X-CTM-Signature on inbound webhooks.
  // Deliberately SEPARATE from CTM_SECRET_KEY (the outbound-API secret): CTM
  // signs sub-account webhooks with a different secret, so reusing the API
  // secret fail-closes every real webhook (401 storm, Northwind Services 500001
  // 2026-07-13). Left UNSET → the signature gate is skipped and the query
  // token is the sole auth (the plan's documented Phase-0 posture). Set this
  // only after the P4 probe confirms CTM's real signing secret + formula.
  CTM_WEBHOOK_SIGNING_SECRET: z.string().trim().optional(),
  CTM_API_BASE: z.string().trim().optional(),
  CTM_RECORDINGS_BUCKET: z.string().trim().default('call-recordings'),
  BACKEND_PUBLIC_URL: z.string().trim().optional(),
  // Phase-0 safety guard: comma-separated E.164 numbers; when set, outbound SMS/calls may ONLY go to these (Phase-0 test guard); unset = unrestricted.
  CTM_OUTBOUND_ALLOWLIST: z.string().trim().optional(),
  // Bridge click-to-call: which request field rings the CALLER's own profile
  // phone first. 'off' (default) = today's body exactly. Values, the agent map
  // format and why a bad value fails the boot: config/bridgeRingCaller.ts.
  // CTM_BRIDGE_AGENT_IDS is spike-scale (staging sitting only).
  CTM_BRIDGE_RING_CALLER: bridgeRingCallerSchema,
  CTM_BRIDGE_AGENT_IDS: bridgeAgentIdsSchema,

  // E2E test doors (provision/teardown/webhook/preflight/seed/probe). Off unless explicitly
  // enabled. NEVER set in production; the whole /api/test block is skipped when
  // NODE_ENV=production and assertNoTestRoutesInProduction() refuses to boot if it leaks.
  E2E_TEST_DOORS: z.string().trim().optional(),
  // Defense-in-depth for the throwaway-org provisioning. The Supabase POOLER hostname is
  // shared between staging and prod, so a host-only allowlist is weak — provisioning
  // requires BOTH the host in E2E_ALLOWED_DB_HOSTS AND the project ref (E2E_ALLOWED_DB_REF,
  // embedded in the connection username, e.g. postgres.<ref>) to be present in DATABASE_URL.
  E2E_ALLOWED_DB_HOSTS: z.string().trim().optional(), // comma-separated allowlist of safe (staging/local) DB hosts
  E2E_ALLOWED_DB_REF: z.string().trim().optional(), // Supabase project ref that MUST appear in DATABASE_URL

  // Email (Resend)
  RESEND_API_KEY: z.string().trim().optional(),
  // AUTH/PLATFORM sender — MFA codes, user invites, AI-farm booking. These bypass
  // dispatchEmail entirely (see lib/email.ts) and stay on the root domain, whose
  // reputation must never depend on contractor sending volume: if this stops
  // landing, nobody can log in.
  // The from-address must live on a verified Resend domain — Resend 403s
  // ("domain is not verified") on any other. Override per-env only if a different
  // verified domain is in use (e.g. a separate prod brand).
  EMAIL_FROM: z.string().trim().default('no-reply@servwave.com'),
  // BUSINESS sender — every customer-facing send routed through dispatchEmail
  // (estimates, invoices, receipts, automations). Deliberately a separate
  // subdomain from EMAIL_FROM so one org's bounce/spam rate can degrade only this
  // reputation, never the auth domain's. dispatchEmail prefixes the org's display
  // name onto it; callers never set a from-address themselves.
  // Verify mail.servwave.com in Resend (DKIM/SPF/DMARC at the subdomain) before
  // pointing an environment at it.
  EMAIL_FROM_BUSINESS: z.string().trim().default('no-reply@mail.servwave.com'),
  // Email slice 6 - INBOUND domain. A dedicated subdomain whose MX points at
  // Resend's inbound MTA (inbound-smtp.us-east-1.amazonaws.com), so every
  // address at it is a catch-all we receive. Deliberately NOT the root domain
  // and NOT EMAIL_FROM_BUSINESS's:
  //  - Never touch a contractor's (or our own) root MX - it hijacks their
  //    entire business email. servwave.com's MX is Google Workspace.
  //  - Separate from mail.servwave.com because inbound here is a catch-all;
  //    sharing it with the From domain would pour every bounce, auto-reply and
  //    out-of-office addressed to no-reply@ into the inbound stream as noise.
  // Reply addresses are `<token>@` this domain - see lib/reply-token.ts.
  EMAIL_REPLY_DOMAIN: z.string().trim().default('reply.servwave.com'),
  // Email slice 4 — Resend delivery-webhook signing secret (resend@6's own
  // resend.webhooks.verify({webhookSecret}), a dedicated svix-based secret from
  // the Resend dashboard, NOT RESEND_API_KEY). Optional at startup, same
  // Phase-0 posture as CTM_WEBHOOK_SIGNING_SECRET: the webhook route itself
  // fails CLOSED (401) at request time when this is unset, so an unconfigured
  // secret rejects all webhook traffic rather than silently accepting
  // unverified payloads.
  RESEND_WEBHOOK_SECRET: z.string().trim().optional(),
  // Where "book a call" requests from the AI Agentic Farm catalog land — always
  // ServWave's own sales inbox, regardless of which org's user is booking.
  AI_FARM_SALES_EMAIL: z.string().trim().default('info@servwave.com'),
  // Invite tokens — HMAC secret for the stateless user-invite links. REQUIRED in
  // production (>=32 chars, enforced in the superRefine below) so invite links
  // never share a secret with the service-role key; in dev/test it may be omitted
  // and invite-token.ts falls back to SUPABASE_SERVICE_ROLE_KEY for zero-config.
  INVITE_TOKEN_SECRET: z.string().trim().optional(),
  // MFA secret — encrypts parked refresh tokens (AES-256-GCM) and HMACs email-OTP
  // codes (lib/mfa-otp.ts). REQUIRED in production (>=32 chars, superRefine below)
  // so the 2FA secret never shares the service-role key and can be rotated
  // independently; in dev/test mfa-otp.ts falls back to SUPABASE_SERVICE_ROLE_KEY.
  MFA_TOKEN_ENC_KEY: z.string().trim().optional(),

  // Redis / rate limiting
  REDIS_URL: z.string().trim().optional(),

  // ─── Copilot (Servy) — voice + the "brain" (text + tool calling) ───
  // The brain is swappable behind one wire contract (see services/copilot/brain.ts):
  //   - 'codex'  → GPT-5.5 via the user's ChatGPT subscription (Codex backend,
  //                metered per 5-hour window, not per-minute). Uses the OAuth token
  //                in ~/.codex/auth.json — no key here. Best model; demo-machine only.
  //   - 'groq'   → Groq's free OpenAI-compatible API (no RPD wall, doesn't train on
  //                prompts). Needs GROQ_API_KEY.
  //   - 'gemini' → Gemini text generateContent (paid Tier 1 for production). Needs
  //                GEMINI_API_KEY.
  // The credential never reaches the client; the browser only POSTs the running
  // conversation to /api/copilot/generate. Speech-to-text (/transcribe) stays on
  // Gemini regardless. The generate endpoint returns 503 ("not configured") until
  // the selected provider's credential is present, so the app still boots without one.
  BRAIN_PROVIDER: z.enum(['codex', 'groq', 'gemini']).default('groq'),
  GEMINI_API_KEY: z.string().trim().optional(),
  GEMINI_TEXT_MODEL: z.string().trim().default('gemini-2.5-flash'),
  // ─── Servy real-time voice (Gemini Live) ───
  // The browser opens ONE WebSocket straight to Gemini Live for native voice
  // (mic in / audio out, barge-in, live transcript). The server only mints a
  // single-use ephemeral token so the GEMINI_API_KEY never reaches the client;
  // the model is the "mouth" and delegates every CRM question/action to the
  // existing brain via the ask_servy tool. Live is metered on concurrent
  // sessions, not requests/day, so it survives the free tier. Pin the 2.5
  // native-audio preview — it's the one that supports NON_BLOCKING tool calls.
  GEMINI_LIVE_MODEL: z.string().trim().default('gemini-2.5-flash-native-audio-preview-12-2025'),
  // Prebuilt voice (Puck, Kore, Charon, Fenrir, Aoede, Leda, Orus, Zephyr…).
  COPILOT_VOICE_NAME: z.string().trim().default('Puck'),
  // Ephemeral-token lifetime: a voice session may stay open this long; a new
  // session can only be started within the first minute of the token.
  COPILOT_SESSION_MINUTES: z.coerce.number().default(30),
  GROQ_API_KEY: z.string().trim().optional(),
  // llama-3.3-70b reliably fills our real tool schemas under full load (16 tools
  // + persona); the smaller llama-4-scout drops required fields. Tradeoff: 70b's
  // free tier is 12K tokens/min, so very long multi-round turns can rate-limit —
  // acceptable for a demo; GitHub Models gpt-4o-mini is the rock-solid upgrade.
  GROQ_MODEL: z.string().trim().default('llama-3.3-70b-versatile'),
  GROQ_BASE_URL: z.string().trim().default('https://api.groq.com/openai/v1'),
  // Codex (ChatGPT-subscription) brain. CODEX_AUTH_PATH defaults to ~/.codex/auth.json.
  CODEX_MODEL: z.string().trim().default('gpt-5.5'),
  CODEX_AUTH_PATH: z.string().trim().optional(),
  CODEX_SESSION_ID: z.string().trim().default('00000000-0000-0000-0000-0000000005e1'),
  COPILOT_RATELIMIT_CAPACITY: z.coerce.number().default(30),
  COPILOT_RATELIMIT_REFILL_PER_MIN: z.coerce.number().default(15),
})
.superRefine((env, ctx) => {
  // Production-only TLS guard: defense-in-depth alongside Supabase's "Enforce SSL"
  // toggle. If someone ever toggles the server-side enforcement off (or pastes a
  // mis-configured URL), the client-side sslmode=require keeps connections safe.
  if (env.NODE_ENV !== 'production') return;

  if (!/[?&]sslmode=require\b/.test(env.DATABASE_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message:
        'DATABASE_URL must include ?sslmode=require in production. ' +
        'Example: postgresql://user:pass@host:6543/db?pgbouncer=true&connection_limit=1&sslmode=require',
    });
  }

  if (env.DIRECT_URL && !/[?&]sslmode=require\b/.test(env.DIRECT_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DIRECT_URL'],
      message:
        'DIRECT_URL must include ?sslmode=require in production. ' +
        'Example: postgresql://user:pass@host:5432/db?sslmode=require',
    });
  }

  // MFA mailer guard: email-OTP 2FA (per-user mfa_email_enrolled) is the only second
  // factor we actually enforce. Without a configured mailer, an enrolled login silently
  // falls back to LOGGING the code (lib/email.ts) and the user is locked out — a
  // security + availability footgun. Refuse to boot in prod without a mailer (F-09b).
  if (!env.RESEND_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['RESEND_API_KEY'],
      message:
        'RESEND_API_KEY is required in production: email-OTP 2FA cannot deliver login codes without a configured mailer.',
    });
  }

  // Invite links must NOT share a secret with the service-role key in prod (key
  // reuse + independent rotation). Require a dedicated, sufficiently long secret;
  // invite-token.ts refuses the service-role fallback in production (F-26/F-56).
  if (!env.INVITE_TOKEN_SECRET || env.INVITE_TOKEN_SECRET.length < 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['INVITE_TOKEN_SECRET'],
      message:
        'INVITE_TOKEN_SECRET must be set to a random value of at least 32 characters in production.',
    });
  }

  // Same rule for the MFA secret: it must NOT share the service-role key in prod
  // (a service-role leak must not also yield OTP forgery / refresh-token
  // decryption, and 2FA must rotate independently). mfa-otp.ts refuses the
  // service-role fallback in production, so without this the app would boot and
  // then throw at first 2FA use — fail at boot instead (authn-2).
  if (!env.MFA_TOKEN_ENC_KEY || env.MFA_TOKEN_ENC_KEY.length < 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MFA_TOKEN_ENC_KEY'],
      message:
        'MFA_TOKEN_ENC_KEY must be set to a random value of at least 32 characters in production.',
    });
  }
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
