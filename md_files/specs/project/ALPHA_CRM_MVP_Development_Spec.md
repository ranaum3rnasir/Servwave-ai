# ALPHA CRM - Phase 0 MVP Development Specification

## Project Overview

**ALPHA CRM** is an offline-first field service management platform for SMB contractors (5-30 technicians) in HVAC, plumbing, electrical, and related trades. This specification covers Phase 0: an internal dual-run MVP to validate core workflows.

### Target Users
- **Industries**: HVAC, plumbing, electrical, and related field service trades
- **Company Size**: 5-30 technicians
- **Price Points**: $49/$179/$349 per account with unlimited users

### Core Value Propositions
1. Offline-first with automatic conflict-free sync
2. Financial cockpit with real-time job profitability
3. Smart AI scheduling (traffic, skills, inventory, margins)
4. Native barcode inventory tracking
5. Integrated VoIP call logging
6. Customer self-service portal

---

## Phase 0 Scope: MVP for Internal Dual Run

### Supported Workflows

#### 1. Standard Flow (Estimate + Deposit-Gated)
```
Lead intake → Assign to Sales → Record walkthrough (optional) → 
Create/Send estimate → Customer outcome (approve/decline/expire/withdraw) → 
Collect deposit (Stripe sandbox) → Create job (deposit-gated) → 
Schedule/Dispatch → Technician executes → Invoice → Payment
```

#### 2. Urgent Flow (No Estimate, No Deposit)
```
Create lead → Start Urgent Job → Add services/charges → 
Generate invoice → Collect payment on-site (card/cash) → Close
```

### Key Features
- Role-based permissions (Owner/Admin, Sales, Dispatcher, Technician)
- Dashboard with key stats and action queues
- Reports with drilldowns (sales performance, closing rate, cancellations)
- Stripe sandbox integration for payments
- Timeline/audit tracking

---

## Technical Architecture

### Recommended Stack

This stack is optimized for **fast MVP development** (8-12 weeks to production) while maintaining professional quality and easy scalability. It leverages Supabase for infrastructure while maintaining full control over business logic.

#### Architecture Overview

```
┌─────────────────────────────────────────┐
│    FRONTEND (React + TypeScript)        │
│  • Vite build tool (fast dev server)    │
│  • shadcn/ui components                 │
│  • TanStack Query (server state)        │
│  • React Router v6                      │
│  • Hosted on Vercel                     │
└─────────────────┬───────────────────────┘
                  │
                  │ HTTPS/REST API
                  │
┌─────────────────▼───────────────────────┐
│   BACKEND (Node.js + Express + TS)      │
│  • Express.js 4.x framework             │
│  • Prisma ORM (type-safe queries)       │
│  • Zod validation                       │
│  • JWT middleware                       │
│  • Hosted on Railway                    │
└─────────────────┬───────────────────────┘
                  │
        ┌─────────┼─────────┬─────────────┐
        │         │         │             │
        ▼         ▼         ▼             ▼
   ┌────────┐ ┌──────┐ ┌────────┐   ┌─────────┐
   │Supabase│ │Stripe│ │Supabase│   │Supabase │
   │  Auth  │ │  API │ │Storage │   │   DB    │
   │  (JWT) │ │      │ │ (S3)   │   │(Postgres)│
   └────────┘ └──────┘ └────────┘   └─────────┘
```

#### Frontend Stack

**Core Framework:**
- **Build Tool**: Vite 5.x
  - Instant server start, lightning-fast HMR
  - Native ES modules, optimized builds
  - Better DX than Create React App
- **Framework**: React 18.2+
- **Language**: TypeScript 5.x
- **Node Version**: 20 LTS

**UI & Styling:**
- **Component Library**: shadcn/ui
  - Copy-paste components (not npm dependency)
  - Built on Radix UI (accessible)
  - Fully customizable with Tailwind
- **CSS**: Tailwind CSS 3.x
- **Icons**: Lucide React (modern, tree-shakeable)

**State Management:**
- **Server State**: TanStack Query v5 (React Query)
  - Automatic caching & refetching
  - Optimistic updates
  - Background sync
- **Client State**: Zustand
  - Simple, lightweight (< 1KB)
  - No boilerplate
  - TypeScript-friendly

**Forms & Validation:**
- **Forms**: React Hook Form
  - Performant (uncontrolled components)
  - Easy integration with UI libraries
- **Validation**: Zod
  - Runtime + compile-time type safety
  - Share schemas between frontend/backend
  - Great error messages

**Routing & Navigation:**
- **Router**: React Router v6
- **Code Splitting**: React.lazy + Suspense

**Data Display:**
- **Tables**: TanStack Table v8
  - Headless (bring your own UI)
  - Sorting, filtering, pagination
- **Calendar**: react-big-calendar
  - Google Calendar-like interface
  - Drag-and-drop scheduling
- **Charts**: Recharts (for dashboard)

**HTTP & API:**
- **Client**: Axios
  - Interceptors for auth tokens
  - Better error handling than fetch
  - Request/response transformations

#### Backend Stack

**Core Framework:**
- **Runtime**: Node.js 20 LTS
- **Framework**: Express.js 4.19+
- **Language**: TypeScript 5.x
- **Process Manager**: PM2 (production)

**Database & ORM:**
- **Database**: Supabase PostgreSQL
  - Managed, auto-backups
  - Connection pooling built-in
  - Free tier: 500MB, 50k MAU
- **ORM**: Prisma 5.x
  - Type-safe database access
  - Auto-generated TypeScript types
  - Excellent migration system
  - Great Supabase integration

**Authentication:**
- **Provider**: Supabase Auth
  - JWT-based (stateless)
  - Email/password + magic links
  - Password reset built-in
  - Session management
- **Backend**: Verify JWT in Express middleware

**Validation & Security:**
- **Validation**: Zod (share schemas with frontend)
- **Password Hashing**: bcrypt (cost factor 12)
- **Rate Limiting**: express-rate-limit
- **CORS**: cors middleware
- **Helmet**: Security headers

**File Storage:**
- **Provider**: Supabase Storage
  - S3-compatible API
  - Image transformations
  - Public/private buckets
  - Free tier: 1GB storage

#### Payment Integration

- **Provider**: Stripe
- **SDK**: stripe (Node.js)
- **Frontend**: @stripe/stripe-js + @stripe/react-stripe-js
- **Webhooks**: Express endpoint with signature verification
- **Mode**: Test/Sandbox for Phase 0

#### Hosting & Deployment

**Frontend:**
- **Platform**: Vercel
- **Features**: 
  - Auto-deploy from GitHub
  - Global CDN (150+ edge locations)
  - Zero-config deployment
  - Preview deployments (PR branches)
  - Analytics & monitoring
- **Cost**: Free tier (sufficient for MVP)

**Backend:**
- **Platform**: Railway
- **Features**:
  - Auto-deploy from GitHub
  - Environment variables UI
  - Built-in PostgreSQL (if needed)
  - Metrics & logs
  - Easy scaling
- **Cost**: ~$5/month (hobby tier)
- **Alternative**: Render (has free tier, but slower cold starts)

**Database & Auth:**
- **Platform**: Supabase Cloud
- **Free Tier Limits**:
  - 500MB database
  - 50k monthly active users
  - 1GB file storage
  - 2GB bandwidth
  - Automatic backups (7 days)
- **Upgrade**: Pro tier at $25/mo when needed

**Total MVP Cost: $0-5/month**

#### Development Tools

**Version Control:**
- **Platform**: GitHub
- **Branch Strategy**: 
  - `main` (production)
  - `develop` (staging)
  - `feature/*` (new features)
  - `bugfix/*` (bug fixes)
- **PR Requirements**: Code review, passing tests

**Code Quality:**
- **Linting**: ESLint (frontend & backend)
- **Formatting**: Prettier
- **Pre-commit**: Husky + lint-staged
- **Type Checking**: TypeScript strict mode

**Testing:**
- **Unit Tests**: Vitest (faster than Jest, Vite-native)
- **E2E Tests**: Playwright (multi-browser support)
- **API Tests**: Supertest + Vitest
- **Coverage**: c8 (native V8 coverage)

**API Documentation:**
- **Spec**: OpenAPI 3.0
- **UI**: Swagger UI
- **Generation**: typescript-swagger (from TypeScript types)

**Monitoring & Debugging:**
- **Error Tracking**: Sentry (free tier: 5k events/mo)
- **Logs**: Railway built-in logs + Axiom (free tier)
- **Performance**: Vercel Analytics (free)

#### Project Structure

**Monorepo Layout:**
```
alpha-crm/
├── frontend/              # React application
│   ├── public/
│   ├── src/
│   │   ├── components/    # Reusable UI components
│   │   │   ├── ui/        # shadcn/ui components
│   │   │   ├── forms/     # Form components
│   │   │   ├── layout/    # Layout components
│   │   │   └── ...
│   │   ├── features/      # Feature-based modules
│   │   │   ├── auth/
│   │   │   ├── leads/
│   │   │   ├── estimates/
│   │   │   ├── jobs/
│   │   │   ├── invoices/
│   │   │   └── dashboard/
│   │   ├── hooks/         # Custom React hooks
│   │   ├── lib/           # Utility functions
│   │   ├── services/      # API client functions
│   │   ├── types/         # TypeScript types
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── tailwind.config.js
│
├── backend/               # Express API
│   ├── prisma/
│   │   ├── schema.prisma  # Database schema
│   │   └── migrations/    # Migration files
│   ├── src/
│   │   ├── controllers/   # Route handlers
│   │   ├── middleware/    # Auth, validation, etc.
│   │   ├── services/      # Business logic
│   │   ├── routes/        # API routes
│   │   ├── utils/         # Helper functions
│   │   ├── validators/    # Zod schemas
│   │   ├── types/         # TypeScript types
│   │   └── index.ts       # App entry point
│   ├── tests/
│   │   ├── unit/
│   │   └── integration/
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
│
├── shared/                # Shared code (optional)
│   ├── types/             # Shared TypeScript types
│   └── validators/        # Shared Zod schemas
│
├── .github/
│   └── workflows/         # CI/CD pipelines
├── README.md
└── package.json           # Root package.json (workspace)
```

#### Package.json Examples

**Frontend package.json:**
```json
{
  "name": "alpha-crm-frontend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "lint": "eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0",
    "format": "prettier --write \"src/**/*.{ts,tsx,json,css}\"",
    "test": "vitest",
    "test:ui": "vitest --ui",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.22.0",
    "@tanstack/react-query": "^5.22.0",
    "@tanstack/react-table": "^8.12.0",
    "zustand": "^4.5.0",
    "react-hook-form": "^7.50.0",
    "zod": "^3.22.4",
    "@hookform/resolvers": "^3.3.4",
    "axios": "^1.6.7",
    "@supabase/supabase-js": "^2.39.3",
    "@stripe/stripe-js": "^3.0.6",
    "@stripe/react-stripe-js": "^2.5.0",
    "react-big-calendar": "^1.10.3",
    "recharts": "^2.12.0",
    "lucide-react": "^0.323.0",
    "date-fns": "^3.3.1",
    "clsx": "^2.1.0",
    "tailwind-merge": "^2.2.1"
  },
  "devDependencies": {
    "@types/react": "^18.2.55",
    "@types/react-dom": "^18.2.19",
    "@vitejs/plugin-react": "^4.2.1",
    "typescript": "^5.3.3",
    "vite": "^5.1.0",
    "tailwindcss": "^3.4.1",
    "autoprefixer": "^10.4.17",
    "postcss": "^8.4.35",
    "eslint": "^8.56.0",
    "prettier": "^3.2.5",
    "vitest": "^1.2.2",
    "@playwright/test": "^1.41.2",
    "@vitest/ui": "^1.2.2"
  }
}
```

**Backend package.json:**
```json
{
  "name": "alpha-crm-backend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev",
    "prisma:migrate:prod": "prisma migrate deploy",
    "prisma:studio": "prisma studio",
    "lint": "eslint . --ext ts --report-unused-disable-directives --max-warnings 0",
    "format": "prettier --write \"src/**/*.ts\"",
    "test": "vitest",
    "test:coverage": "vitest --coverage"
  },
  "dependencies": {
    "express": "^4.18.2",
    "@supabase/supabase-js": "^2.39.3",
    "@prisma/client": "^5.9.1",
    "stripe": "^14.17.0",
    "zod": "^3.22.4",
    "bcrypt": "^5.1.1",
    "jsonwebtoken": "^9.0.2",
    "cors": "^2.8.5",
    "helmet": "^7.1.0",
    "express-rate-limit": "^7.1.5",
    "dotenv": "^16.4.1",
    "winston": "^3.11.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/bcrypt": "^5.0.2",
    "@types/jsonwebtoken": "^9.0.5",
    "@types/cors": "^2.8.17",
    "@types/node": "^20.11.17",
    "typescript": "^5.3.3",
    "tsx": "^4.7.1",
    "prisma": "^5.9.1",
    "eslint": "^8.56.0",
    "prettier": "^3.2.5",
    "vitest": "^1.2.2",
    "supertest": "^6.3.4",
    "@vitest/coverage-c8": "^0.33.0"
  }
}
```

#### Environment Variables

**Frontend (.env):**
```bash
# API
VITE_API_URL=http://localhost:3000/api
VITE_API_URL_PROD=https://api.alphacrm.com

# Supabase
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGc...
# Note: Anon key is safe to expose (RLS policies protect data)

# Stripe
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...

# App
VITE_APP_NAME=ALPHA CRM
VITE_APP_VERSION=0.1.0
```

**Backend (.env):**
```bash
# Server
NODE_ENV=development
PORT=3000
API_BASE_URL=http://localhost:3000

# Database (from Supabase)
DATABASE_URL="postgresql://postgres:[password]@db.[project].supabase.co:5432/postgres"

# Supabase
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...  # For client operations
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...  # SECRET! Admin access

# JWT (for custom auth if needed)
JWT_SECRET=your-super-secret-key-min-32-chars-change-this
JWT_REFRESH_SECRET=your-refresh-secret-key
JWT_EXPIRATION=1h
JWT_REFRESH_EXPIRATION=7d

# Stripe (Test Mode)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Email (Optional for Phase 0 - can log instead)
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASSWORD=SG.xxxxx

# SMS (Optional for Phase 0)
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxxx
TWILIO_PHONE_NUMBER=+1234567890

# Logging
LOG_LEVEL=debug  # production: info

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100

# CORS
CORS_ORIGIN=http://localhost:5173
CORS_ORIGIN_PROD=https://app.alphacrm.com
```

#### Initial Setup Commands

**1. Create Supabase Project:**
```bash
# Go to supabase.com, create new project
# Save the following from project settings:
# - Project URL
# - anon/public key
# - service_role key (SECRET!)
# - Database password
```

**2. Initialize Frontend:**
```bash
# Create Vite project
npm create vite@latest frontend -- --template react-ts

cd frontend
npm install

# Install dependencies
npm install react-router-dom @tanstack/react-query zustand
npm install react-hook-form zod @hookform/resolvers
npm install axios @supabase/supabase-js
npm install @stripe/stripe-js @stripe/react-stripe-js
npm install lucide-react date-fns clsx tailwind-merge

# Install shadcn/ui
npx shadcn-ui@latest init
# Select: Default style, Slate gray, CSS variables

# Add components as needed
npx shadcn-ui@latest add button
npx shadcn-ui@latest add form
npx shadcn-ui@latest add table
npx shadcn-ui@latest add dialog
# ... etc

# Install dev dependencies
npm install -D tailwindcss autoprefixer postcss
npm install -D vitest @vitest/ui @playwright/test
```

**3. Initialize Backend:**
```bash
mkdir backend
cd backend
npm init -y

# Install dependencies
npm install express @supabase/supabase-js @prisma/client
npm install stripe zod bcrypt jsonwebtoken
npm install cors helmet express-rate-limit dotenv winston

# Install dev dependencies
npm install -D typescript tsx prisma
npm install -D @types/express @types/node @types/bcrypt @types/jsonwebtoken @types/cors
npm install -D eslint prettier vitest supertest

# Initialize TypeScript
npx tsc --init
# Set: target: ES2022, module: ES2022, moduleResolution: bundler

# Initialize Prisma
npx prisma init
# This creates prisma/schema.prisma and .env
```

**4. Configure Prisma Schema:**
```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// Example model
model User {
  id            String   @id @default(uuid())
  email         String   @unique
  password_hash String
  first_name    String
  last_name     String
  role          Role     @default(DISPATCHER)
  is_active     Boolean  @default(true)
  created_at    DateTime @default(now())
  updated_at    DateTime @updatedAt

  @@map("users")
}

enum Role {
  ADMIN
  SALES
  DISPATCHER
  TECHNICIAN
}
```

**5. Create Initial Migration:**
```bash
npx prisma migrate dev --name init
# This creates the database schema

npx prisma generate
# This generates TypeScript types
```

**6. Project Scripts (add to root package.json):**
```json
{
  "name": "alpha-crm",
  "version": "0.1.0",
  "private": true,
  "workspaces": [
    "frontend",
    "backend"
  ],
  "scripts": {
    "dev": "concurrently \"npm run dev:backend\" \"npm run dev:frontend\"",
    "dev:frontend": "cd frontend && npm run dev",
    "dev:backend": "cd backend && npm run dev",
    "build": "npm run build:frontend && npm run build:backend",
    "build:frontend": "cd frontend && npm run build",
    "build:backend": "cd backend && npm run build",
    "test": "npm run test:frontend && npm run test:backend",
    "test:frontend": "cd frontend && npm run test",
    "test:backend": "cd backend && npm run test"
  },
  "devDependencies": {
    "concurrently": "^8.2.2"
  }
}
```

#### Why This Stack Wins

**Speed to MVP (8-12 weeks):**
- Vite: Instant dev server, fast builds
- shadcn/ui: Pre-built components, copy-paste
- Prisma: Auto-generated types, easy migrations
- Supabase: Managed infrastructure, no DevOps

**Developer Experience:**
- Full TypeScript: Catch bugs before runtime
- Zod: Share validation between FE/BE
- Prisma: Type-safe database queries
- Hot reload: See changes instantly

**Production Ready:**
- Supabase: Enterprise-grade Postgres
- Vercel/Railway: Auto-scaling
- Stripe: Battle-tested payments
- Monitoring: Sentry error tracking

**Low Cost:**
- Free tier for MVP ($0-5/mo)
- Pay-as-you-grow pricing
- No expensive licenses
- Open-source stack

**Future-Proof:**
- Standard technologies (easy hiring)
- Active communities
- Regular updates
- Can migrate pieces as needed

**Scalability:**
- Handles 1000+ concurrent users
- Horizontal scaling (add more backend servers)
- Database replication (when needed)
- CDN edge caching (Vercel)

---

## Security Architecture & Implementation

### Overview

Security is critical for a CRM handling customer data, financial transactions, and business operations. This section covers authentication, authorization, data protection, and security best practices.

### Authentication Flow

#### How It Works

```
┌──────────┐                 ┌──────────┐                 ┌──────────┐
│ Frontend │                 │  Backend │                 │ Supabase │
│          │                 │          │                 │   Auth   │
└────┬─────┘                 └────┬─────┘                 └────┬─────┘
     │                            │                            │
     │ 1. Login (email/password)  │                            │
     ├───────────────────────────>│                            │
     │                            │ 2. Verify with Supabase    │
     │                            ├───────────────────────────>│
     │                            │                            │
     │                            │ 3. Return JWT + user data  │
     │                            │<───────────────────────────┤
     │                            │                            │
     │ 4. Return JWT + user       │                            │
     │<───────────────────────────┤                            │
     │                            │                            │
     │ Store JWT in localStorage  │                            │
     │                            │                            │
     │ 5. API Request + JWT       │                            │
     ├───────────────────────────>│                            │
     │                            │ 6. Verify JWT              │
     │                            ├───────────────────────────>│
     │                            │                            │
     │                            │ 7. JWT valid + user data   │
     │                            │<───────────────────────────┤
     │                            │                            │
     │                            │ 8. Check role permissions  │
     │                            │                            │
     │ 9. Response                │                            │
     │<───────────────────────────┤                            │
```

#### Frontend: Supabase Client Setup

```typescript
// lib/supabase.ts
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  }
})
```

#### Frontend: Login Function

```typescript
// services/auth.service.ts
import { supabase } from '@/lib/supabase'

export const authService = {
  async login(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    })
    
    if (error) throw error
    
    // Fetch user profile with role from your users table
    const { data: userProfile } = await supabase
      .from('users')
      .select('id, email, first_name, last_name, role, is_active')
      .eq('id', data.user.id)
      .single()
    
    return {
      session: data.session,
      user: userProfile
    }
  },

  async logout() {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  },

  async getSession() {
    const { data: { session } } = await supabase.auth.getSession()
    return session
  },

  async refreshSession() {
    const { data: { session }, error } = await supabase.auth.refreshSession()
    if (error) throw error
    return session
  }
}
```

#### Frontend: Axios Interceptor (Add JWT to Requests)

```typescript
// lib/axios.ts
import axios from 'axios'
import { supabase } from './supabase'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
  headers: {
    'Content-Type': 'application/json'
  }
})

// Request interceptor: Add JWT token
api.interceptors.request.use(
  async (config) => {
    const { data: { session } } = await supabase.auth.getSession()
    
    if (session?.access_token) {
      config.headers.Authorization = `Bearer ${session.access_token}`
    }
    
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor: Handle 401 errors
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config
    
    // If 401 and haven't retried yet
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true
      
      try {
        // Try to refresh the session
        const { data: { session } } = await supabase.auth.refreshSession()
        
        if (session?.access_token) {
          originalRequest.headers.Authorization = `Bearer ${session.access_token}`
          return api(originalRequest)
        }
      } catch (refreshError) {
        // Refresh failed, redirect to login
        await supabase.auth.signOut()
        window.location.href = '/login'
        return Promise.reject(refreshError)
      }
    }
    
    return Promise.reject(error)
  }
)

export default api
```

#### Backend: JWT Verification Middleware

```typescript
// middleware/auth.middleware.ts
import { Request, Response, NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'
import { prisma } from '../lib/prisma'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!  // Use service role key on backend
)

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string
        email: string
        role: 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN'
        first_name: string
        last_name: string
      }
    }
  }
}

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'No authorization token provided'
        }
      })
    }
    
    const token = authHeader.split(' ')[1]
    
    // Verify token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token)
    
    if (error || !user) {
      return res.status(401).json({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Invalid or expired token'
        }
      })
    }
    
    // Get user profile with role from database
    const userProfile = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        role: true,
        is_active: true
      }
    })
    
    if (!userProfile || !userProfile.is_active) {
      return res.status(403).json({
        error: {
          code: 'ACCOUNT_DISABLED',
          message: 'Your account has been disabled'
        }
      })
    }
    
    // Attach user to request object
    req.user = userProfile
    
    next()
  } catch (error) {
    console.error('Authentication error:', error)
    return res.status(500).json({
      error: {
        code: 'AUTH_ERROR',
        message: 'Authentication failed'
      }
    })
  }
}
```

### Authorization (Role-Based Access Control)

#### Middleware: Role Checking

```typescript
// middleware/authorize.middleware.ts
import { Request, Response, NextFunction } from 'express'

type Role = 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN'

export const authorize = (...allowedRoles: Role[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required'
        }
      })
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `This action requires one of the following roles: ${allowedRoles.join(', ')}`
        }
      })
    }
    
    next()
  }
}

// Usage in routes:
// app.post('/api/estimates', authenticate, authorize('SALES', 'ADMIN'), createEstimate)
```

#### Resource Ownership Check

```typescript
// middleware/ownership.middleware.ts
import { Request, Response, NextFunction } from 'express'
import { prisma } from '../lib/prisma'

export const ensureLeadOwnership = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  
  // Admin can access all
  if (req.user.role === 'ADMIN') {
    return next()
  }
  
  // Sales can only access assigned leads
  if (req.user.role === 'SALES') {
    const leadId = req.params.id || req.body.lead_id
    
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { assigned_to: true }
    })
    
    if (!lead || lead.assigned_to !== req.user.id) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'You can only access leads assigned to you'
        }
      })
    }
  }
  
  next()
}
```

### Input Validation

#### Zod Schemas (Shared between Frontend & Backend)

```typescript
// shared/validators/estimate.validator.ts
import { z } from 'zod'

export const createEstimateSchema = z.object({
  lead_id: z.string().uuid('Invalid lead ID'),
  
  line_items: z.array(
    z.object({
      description: z.string()
        .min(1, 'Description required')
        .max(200, 'Description too long'),
      quantity: z.number()
        .positive('Quantity must be positive')
        .max(10000, 'Quantity too large'),
      unit_price: z.number()
        .nonnegative('Price cannot be negative')
        .max(1000000, 'Price too large'),
      is_taxable: z.boolean()
    })
  ).min(1, 'At least one line item required'),
  
  scope_notes: z.string()
    .max(5000, 'Scope notes too long')
    .optional()
})

export type CreateEstimateInput = z.infer<typeof createEstimateSchema>
```

#### Validation Middleware

```typescript
// middleware/validate.middleware.ts
import { Request, Response, NextFunction } from 'express'
import { ZodSchema, ZodError } from 'zod'

export const validate = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate request body
      schema.parse(req.body)
      next()
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            details: error.errors.map(err => ({
              field: err.path.join('.'),
              message: err.message
            }))
          }
        })
      }
      
      next(error)
    }
  }
}

// Usage:
// app.post('/api/estimates', 
//   authenticate, 
//   authorize('SALES', 'ADMIN'),
//   validate(createEstimateSchema),
//   createEstimate
// )
```

### Password Security

#### Hashing with bcrypt

```typescript
// utils/password.util.ts
import bcrypt from 'bcrypt'

const SALT_ROUNDS = 12

export const passwordUtil = {
  async hash(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS)
  },
  
  async verify(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash)
  },
  
  validate(password: string): { valid: boolean; errors: string[] } {
    const errors: string[] = []
    
    if (password.length < 8) {
      errors.push('Password must be at least 8 characters')
    }
    
    if (!/[a-z]/.test(password)) {
      errors.push('Password must contain lowercase letter')
    }
    
    if (!/[A-Z]/.test(password)) {
      errors.push('Password must contain uppercase letter')
    }
    
    if (!/[0-9]/.test(password)) {
      errors.push('Password must contain number')
    }
    
    if (!/[^a-zA-Z0-9]/.test(password)) {
      errors.push('Password must contain special character')
    }
    
    return {
      valid: errors.length === 0,
      errors
    }
  }
}
```

### SQL Injection Prevention

Prisma automatically prevents SQL injection by using parameterized queries:

```typescript
// ✅ SAFE - Prisma parameterizes automatically
const user = await prisma.user.findUnique({
  where: { email: userEmail }  // Prisma handles escaping
})

// ✅ SAFE - Even with raw SQL using Prisma.sql
const results = await prisma.$queryRaw`
  SELECT * FROM users WHERE email = ${userEmail}
`

// ❌ DANGEROUS - Never do this!
const results = await prisma.$queryRawUnsafe(
  `SELECT * FROM users WHERE email = '${userEmail}'`
)
```

### Rate Limiting

```typescript
// middleware/rate-limit.middleware.ts
import rateLimit from 'express-rate-limit'

// General API rate limit
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: {
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, please try again later'
    }
  },
  standardHeaders: true,
  legacyHeaders: false
})

// Strict limit for auth endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // Only 5 login attempts per 15 minutes
  skipSuccessfulRequests: true, // Don't count successful logins
  message: {
    error: {
      code: 'AUTH_RATE_LIMIT_EXCEEDED',
      message: 'Too many login attempts, please try again in 15 minutes'
    }
  }
})

// Usage:
// app.use('/api/', apiLimiter)
// app.post('/api/auth/login', authLimiter, login)
```

### CORS Configuration

```typescript
// middleware/cors.middleware.ts
import cors from 'cors'

const allowedOrigins = [
  process.env.CORS_ORIGIN || 'http://localhost:5173',
  process.env.CORS_ORIGIN_PROD || 'https://app.alphacrm.com'
].filter(Boolean)

export const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman)
    if (!origin) return callback(null, true)
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true, // Allow cookies
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}

// Usage:
// app.use(cors(corsOptions))
```

### Security Headers (Helmet)

```typescript
// middleware/security.middleware.ts
import helmet from 'helmet'

export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", process.env.SUPABASE_URL!],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"]
    }
  },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  }
})

// Usage:
// app.use(securityHeaders)
```

### Stripe Security

#### Webhook Signature Verification

```typescript
// routes/stripe-webhook.route.ts
import express from 'express'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16'
})

const router = express.Router()

router.post(
  '/webhooks/stripe',
  // IMPORTANT: Use raw body for signature verification
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'] as string
    
    let event: Stripe.Event
    
    try {
      // Verify webhook signature
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!
      )
    } catch (err: any) {
      console.error('Webhook signature verification failed:', err.message)
      return res.status(400).send(`Webhook Error: ${err.message}`)
    }
    
    // Handle the event
    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object as Stripe.PaymentIntent
        await handlePaymentSuccess(paymentIntent)
        break
        
      case 'payment_intent.payment_failed':
        const failedPayment = event.data.object as Stripe.PaymentIntent
        await handlePaymentFailure(failedPayment)
        break
        
      default:
        console.log(`Unhandled event type: ${event.type}`)
    }
    
    res.json({ received: true })
  }
)

async function handlePaymentSuccess(paymentIntent: Stripe.PaymentIntent) {
  const { deposit_id, invoice_id } = paymentIntent.metadata
  
  if (deposit_id) {
    await prisma.deposit.update({
      where: { id: deposit_id },
      data: {
        status: 'PAID',
        paid_at: new Date(),
        stripe_payment_intent_id: paymentIntent.id
      }
    })
  }
  
  if (invoice_id) {
    // Create payment record and update invoice
    await prisma.payment.create({
      data: {
        invoice_id,
        amount: paymentIntent.amount / 100, // Convert cents to dollars
        method: 'CARD',
        paid_at: new Date(),
        stripe_payment_intent_id: paymentIntent.id
      }
    })
  }
}
```

### File Upload Security

```typescript
// middleware/upload.middleware.ts
import multer from 'multer'
import path from 'path'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

const allowedMimeTypes = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf'
]

// Memory storage for uploading to Supabase
const storage = multer.memoryStorage()

export const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE
  },
  fileFilter: (req, file, cb) => {
    // Check MIME type
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return cb(new Error('Invalid file type. Allowed: images and PDFs'))
    }
    
    // Check file extension
    const ext = path.extname(file.originalname).toLowerCase()
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf']
    
    if (!allowedExts.includes(ext)) {
      return cb(new Error('Invalid file extension'))
    }
    
    cb(null, true)
  }
})

// Usage:
// app.post('/api/attachments', upload.single('file'), uploadAttachment)
```

#### Upload to Supabase Storage

```typescript
// services/storage.service.ts
import { supabase } from '../lib/supabase'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'

export const storageService = {
  async uploadFile(
    file: Express.Multer.File,
    folder: 'attachments' | 'photos'
  ) {
    const fileExt = path.extname(file.originalname)
    const fileName = `${uuidv4()}${fileExt}`
    const filePath = `${folder}/${fileName}`
    
    const { data, error } = await supabase.storage
      .from('alpha-crm-files')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false
      })
    
    if (error) throw error
    
    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from('alpha-crm-files')
      .getPublicUrl(filePath)
    
    return {
      file_name: file.originalname,
      file_path: filePath,
      file_url: publicUrl,
      file_type: file.mimetype,
      file_size: file.size
    }
  },
  
  async deleteFile(filePath: string) {
    const { error } = await supabase.storage
      .from('alpha-crm-files')
      .remove([filePath])
    
    if (error) throw error
  }
}
```

### Environment Variables Security

```typescript
// config/env.config.ts
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']),
  PORT: z.string().transform(Number),
  
  DATABASE_URL: z.string().url(),
  
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string(),
  SUPABASE_SERVICE_ROLE_KEY: z.string(),
  
  STRIPE_SECRET_KEY: z.string(),
  STRIPE_PUBLISHABLE_KEY: z.string(),
  STRIPE_WEBHOOK_SECRET: z.string(),
  
  CORS_ORIGIN: z.string().optional(),
  CORS_ORIGIN_PROD: z.string().url().optional(),
  
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
})

// Validate environment variables at startup
export const env = envSchema.parse(process.env)

// Now you can use env.DATABASE_URL with type safety
```

### Logging (Winston)

```typescript
// utils/logger.util.ts
import winston from 'winston'

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error' 
    }),
    new winston.transports.File({ 
      filename: 'logs/combined.log' 
    })
  ]
})

export default logger

// Usage:
// logger.info('User logged in', { userId: user.id })
// logger.error('Payment failed', { error, paymentId })
```

### Security Checklist

**Before Deployment:**
- [ ] All environment variables in .env files (never commit!)
- [ ] Supabase service role key is SECRET (backend only)
- [ ] HTTPS enforced (Vercel/Railway handle this)
- [ ] CORS configured with specific origins
- [ ] Rate limiting enabled on all routes
- [ ] Input validation on all endpoints
- [ ] Password requirements enforced (8+ chars, mixed case, number, symbol)
- [ ] Stripe webhook signature verification
- [ ] File upload size limits (10MB)
- [ ] File type restrictions (images, PDFs only)
- [ ] SQL injection prevented (Prisma parameterization)
- [ ] XSS prevented (React auto-escapes, helmet CSP)
- [ ] JWT expiration set (1 hour access, 7 days refresh)
- [ ] Database backups enabled (Supabase automatic)
- [ ] Error tracking enabled (Sentry)
- [ ] Logging implemented (Winston)

**Production Hardening:**
- [ ] Change all default secrets
- [ ] Enable 2FA for admin accounts
- [ ] Set up monitoring alerts
- [ ] Configure security headers (helmet)
- [ ] Enable audit logging for sensitive actions
- [ ] Regular dependency updates (npm audit)
- [ ] Penetration testing (before launch)

---

## Data Model

### Core Entities and Relationships

```typescript
// Entity: Customer
Customer {
  id: UUID (PK)
  name: string
  email: string (nullable)
  phone: string
  service_locations: ServiceLocation[]
  created_at: timestamp
  updated_at: timestamp
}

// Entity: ServiceLocation
ServiceLocation {
  id: UUID (PK)
  customer_id: UUID (FK → Customer)
  address_line1: string
  address_line2: string (nullable)
  city: string
  state: string
  zip: string
  is_primary: boolean
  created_at: timestamp
}

// Entity: Lead
Lead {
  id: UUID (PK)
  customer_id: UUID (FK → Customer)
  assigned_to: UUID (FK → User, nullable)
  status: enum ['New', 'Contacted', 'Estimating', 'Won', 'Lost']
  service_request: text
  
  // Walkthrough details (stored on Lead, no separate entity)
  walkthrough_scheduled_at: timestamp (nullable)
  walkthrough_completed_at: timestamp (nullable)
  walkthrough_notes: text (nullable)
  
  notes: text (nullable)
  lost_at: timestamp (nullable)
  lost_reason: text (nullable)
  created_at: timestamp
  updated_at: timestamp
}

// Entity: Estimate
Estimate {
  id: UUID (PK)
  lead_id: UUID (FK → Lead)
  estimate_number: string (auto-generated, unique)
  status: enum ['Draft', 'Sent', 'Approved', 'Declined', 'Expired', 'Cancelled']
  
  // Timestamps for lifecycle
  sent_at: timestamp (nullable)
  approved_at: timestamp (nullable)
  declined_at: timestamp (nullable)
  expired_at: timestamp (nullable)
  cancelled_at: timestamp (nullable)
  
  cancelled_reason: text (nullable) // For Withdrawn/Cancelled
  
  scope_notes: text (nullable) // Free text for scope/assumptions/exclusions
  
  subtotal: decimal
  tax_amount: decimal
  total_amount: decimal
  
  created_by: UUID (FK → User)
  created_at: timestamp
  updated_at: timestamp
  
  line_items: EstimateLineItem[]
  deposit: Deposit (nullable, one-to-one)
  job: Job (nullable, one-to-one)
}

// Entity: EstimateLineItem
EstimateLineItem {
  id: UUID (PK)
  estimate_id: UUID (FK → Estimate)
  sequence: integer
  description: string
  quantity: decimal
  unit_price: decimal
  is_taxable: boolean
  line_total: decimal (computed: quantity * unit_price)
}

// Entity: Deposit
Deposit {
  id: UUID (PK)
  estimate_id: UUID (FK → Estimate, unique)
  amount: decimal
  status: enum ['Requested', 'Paid']
  requested_at: timestamp
  paid_at: timestamp (nullable)
  stripe_payment_intent_id: string (nullable)
  created_at: timestamp
}

// Entity: Job
Job {
  id: UUID (PK)
  job_number: string (auto-generated, unique)
  customer_id: UUID (FK → Customer)
  service_location_id: UUID (FK → ServiceLocation)
  
  // Origin tracking
  estimate_id: UUID (FK → Estimate, nullable) // Null for urgent jobs
  is_urgent: boolean (default: false)
  urgency_reason: text (nullable) // Required for urgent jobs
  
  status: enum ['Unassigned', 'Scheduled', 'In Progress', 'Completed', 'Cancelled']
  
  assigned_to: UUID (FK → User, nullable)
  scheduled_start: timestamp (nullable)
  scheduled_end: timestamp (nullable)
  
  scope_notes: text (nullable) // Auto-populated from estimate or manual
  
  completed_at: timestamp (nullable)
  cancelled_at: timestamp (nullable)
  cancelled_reason: text (nullable)
  
  created_at: timestamp
  updated_at: timestamp
  
  charges: JobCharge[] // For urgent jobs and change work
  invoice: Invoice (nullable, one-to-one)
}

// Entity: JobCharge (for urgent jobs)
JobCharge {
  id: UUID (PK)
  job_id: UUID (FK → Job)
  sequence: integer
  description: string
  quantity: decimal
  unit_price: decimal
  is_taxable: boolean
  line_total: decimal (computed)
}

// Entity: Invoice
Invoice {
  id: UUID (PK)
  invoice_number: string (auto-generated, unique)
  job_id: UUID (FK → Job, unique)
  
  status: enum ['Draft', 'Sent', 'Partial', 'Paid']
  
  subtotal: decimal
  tax_amount: decimal
  deposit_credit: decimal (default: 0)
  total_amount: decimal
  amount_due: decimal (computed: total - deposit_credit - payments)
  
  sent_at: timestamp (nullable)
  paid_at: timestamp (nullable)
  
  created_at: timestamp
  updated_at: timestamp
  
  payments: Payment[]
}

// Entity: Payment
Payment {
  id: UUID (PK)
  invoice_id: UUID (FK → Invoice)
  amount: decimal
  method: enum ['Card', 'Cash', 'Check']
  
  paid_at: timestamp
  collected_by: UUID (FK → User) // Auto-filled, editable by Dispatcher/Admin only
  
  stripe_payment_intent_id: string (nullable)
  notes: text (nullable)
  
  created_at: timestamp
}

// Entity: User
User {
  id: UUID (PK)
  email: string (unique)
  password_hash: string
  first_name: string
  last_name: string
  role: enum ['Admin', 'Sales', 'Dispatcher', 'Technician']
  is_active: boolean
  created_at: timestamp
  updated_at: timestamp
}

// Entity: Attachment
Attachment {
  id: UUID (PK)
  entity_type: enum ['Lead', 'Estimate', 'Job', 'Invoice']
  entity_id: UUID
  file_name: string
  file_url: string (S3 or storage URL)
  file_type: string (MIME type)
  file_size: integer (bytes)
  uploaded_by: UUID (FK → User)
  created_at: timestamp
}

// Entity: Note
Note {
  id: UUID (PK)
  entity_type: enum ['Lead', 'Estimate', 'Job', 'Invoice', 'Customer']
  entity_id: UUID
  content: text
  created_by: UUID (FK → User)
  created_at: timestamp
}

// Entity: TimelineEvent (Audit log)
TimelineEvent {
  id: UUID (PK)
  entity_type: string
  entity_id: UUID
  event_type: string (e.g., 'lead_created', 'estimate_sent', 'deposit_paid')
  description: string
  metadata: jsonb (flexible data)
  created_by: UUID (FK → User, nullable)
  created_at: timestamp
}
```

### Database Indexes (Performance Critical)

```sql
-- Leads
CREATE INDEX idx_leads_assigned_to ON leads(assigned_to);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_customer_id ON leads(customer_id);

-- Estimates
CREATE INDEX idx_estimates_lead_id ON estimates(lead_id);
CREATE INDEX idx_estimates_status ON estimates(status);
CREATE INDEX idx_estimates_created_by ON estimates(created_by);

-- Jobs
CREATE INDEX idx_jobs_customer_id ON jobs(customer_id);
CREATE INDEX idx_jobs_assigned_to ON jobs(assigned_to);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_scheduled_start ON jobs(scheduled_start);
CREATE INDEX idx_jobs_estimate_id ON jobs(estimate_id);

-- Invoices
CREATE INDEX idx_invoices_job_id ON invoices(job_id);
CREATE INDEX idx_invoices_status ON invoices(status);

-- Timeline
CREATE INDEX idx_timeline_entity ON timeline_events(entity_type, entity_id);
CREATE INDEX idx_timeline_created_at ON timeline_events(created_at);
```

---

## API Endpoints Specification

### Authentication

```
POST /api/auth/login
POST /api/auth/logout
POST /api/auth/refresh
GET  /api/auth/me
```

### Customers

```
GET    /api/customers
POST   /api/customers
GET    /api/customers/:id
PATCH  /api/customers/:id
DELETE /api/customers/:id
```

### Leads

```
GET    /api/leads
POST   /api/leads
GET    /api/leads/:id
PATCH  /api/leads/:id
POST   /api/leads/:id/assign              // Assign to sales rep
POST   /api/leads/:id/walkthrough          // Update walkthrough details
POST   /api/leads/:id/mark-lost            // Mark as lost with reason
POST   /api/leads/:id/start-urgent-job     // Start urgent job flow
```

### Estimates

```
GET    /api/estimates
POST   /api/estimates                      // Create from lead
GET    /api/estimates/:id
PATCH  /api/estimates/:id
POST   /api/estimates/:id/send             // Send to customer, record sent_at
POST   /api/estimates/:id/cancel           // Mark as cancelled/withdrawn with reason
GET    /api/estimates/:id/public           // Public view for customer (token-based)
POST   /api/estimates/:id/approve          // Customer approval action
POST   /api/estimates/:id/decline          // Customer decline action
```

### Deposits

```
POST   /api/deposits                       // Request deposit for estimate
GET    /api/deposits/:id
POST   /api/deposits/:id/pay               // Process payment (Stripe)
```

### Jobs

```
GET    /api/jobs
POST   /api/jobs                           // Create from estimate (deposit-gated)
GET    /api/jobs/:id
PATCH  /api/jobs/:id
POST   /api/jobs/:id/schedule              // Schedule job
POST   /api/jobs/:id/assign                // Assign technician
POST   /api/jobs/:id/start                 // Mark in progress
POST   /api/jobs/:id/complete              // Mark completed
POST   /api/jobs/:id/cancel                // Cancel with reason
GET    /api/jobs/today                     // Technician's jobs for today
```

### Job Charges (for urgent jobs)

```
GET    /api/jobs/:jobId/charges
POST   /api/jobs/:jobId/charges
PATCH  /api/jobs/:jobId/charges/:id
DELETE /api/jobs/:jobId/charges/:id
```

### Invoices

```
GET    /api/invoices
POST   /api/invoices                       // Generate from job
GET    /api/invoices/:id
POST   /api/invoices/:id/send              // Send to customer
GET    /api/invoices/:id/public            // Public view (token-based)
```

### Payments

```
POST   /api/payments                       // Record payment (card or cash)
GET    /api/payments/:id
PATCH  /api/payments/:id                   // Update (Dispatcher/Admin only)
```

### Dashboard

```
GET    /api/dashboard/stats                // All dashboard tiles
GET    /api/dashboard/leads-needing-followup
GET    /api/dashboard/estimates-awaiting-response
GET    /api/dashboard/approved-estimates-no-deposit
GET    /api/dashboard/jobs-today
GET    /api/dashboard/outstanding-invoices
GET    /api/dashboard/sales-by-rep
GET    /api/dashboard/cash-collected-today
GET    /api/dashboard/cancellations
```

### Reports

```
GET    /api/reports/pipeline               // Leads by status + aging
GET    /api/reports/estimate-funnel        // Sent/approved/declined/expired/withdrawn
GET    /api/reports/deposits               // Requested vs paid + aging
GET    /api/reports/ops                    // Jobs by status, workload
GET    /api/reports/finance                // Outstanding invoices, payments, aging
GET    /api/reports/sales-performance      // Sales by rep, avg value, counts
GET    /api/reports/closing-rate           // Approved/sent, won/total
GET    /api/reports/cancellation-rates     // Lead lost, estimate withdrawn, job cancelled
```

### Attachments & Notes

```
POST   /api/attachments                    // Upload file
GET    /api/attachments/:id
DELETE /api/attachments/:id

POST   /api/notes
GET    /api/notes
PATCH  /api/notes/:id
DELETE /api/notes/:id
```

### Users (Admin only)

```
GET    /api/users
POST   /api/users
GET    /api/users/:id
PATCH  /api/users/:id
DELETE /api/users/:id
```

---

## Role-Based Permissions Matrix

### Sales

| Action | Permission |
|--------|-----------|
| Create/edit leads assigned to them | ✅ |
| View all leads | ❌ (only assigned) |
| Add walkthrough notes/photos | ✅ (on assigned leads) |
| Create/edit/send estimates | ✅ (on assigned leads) |
| Mark estimate as Cancelled/Withdrawn | ✅ (with text reason) |
| View deposit status for their estimates | ✅ |
| View job progress for their sold work | ✅ (read-only) |
| Create jobs | ❌ |
| Schedule/dispatch | ❌ |
| View own sales performance | ✅ (dashboard + reports) |
| View global dashboard/reports | ❌ |
| Manage users | ❌ |

### Dispatcher

| Action | Permission |
|--------|-----------|
| Create leads | ✅ |
| Assign/reassign leads to Sales | ✅ |
| Start Urgent Job | ✅ |
| Create job from estimate | ✅ (deposit-gated) |
| Schedule/dispatch jobs | ✅ |
| Update job status | ✅ |
| Send invoices | ✅ |
| Record payments | ✅ |
| Cancel jobs | ✅ (with text reason) |
| View global dashboard + reports | ✅ |
| Manage users | ❌ |

### Technician

| Action | Permission |
|--------|-----------|
| View assigned jobs | ✅ (only their jobs) |
| Update job status, notes, photos | ✅ |
| Mark job complete | ✅ |
| Create lead for urgent | ✅ |
| Start Urgent Job | ✅ |
| Add job charges (urgent) | ✅ |
| Generate invoice (urgent) | ✅ |
| Collect payment on-site | ✅ (card/cash) |
| View global dashboard | ❌ |
| Schedule jobs | ❌ |

### Admin/Owner

| Action | Permission |
|--------|-----------|
| All actions | ✅ |
| Manage roles/users | ✅ |
| View/edit all data | ✅ |
| Configuration | ✅ |

---

## UI/UX Requirements

### Design System
- Clean, modern interface optimized for speed
- Mobile-responsive (especially for technician views)
- Consistent color coding for statuses
- Clear visual hierarchy
- Minimal clicks to complete actions

### Color Coding (Recommended)
- **New/Draft**: Blue
- **Active/In Progress**: Orange
- **Success/Completed/Paid**: Green
- **Attention/Warning**: Yellow
- **Problem/Cancelled/Declined**: Red
- **Neutral/Expired**: Gray

### Key UX Decisions

#### "Start Urgent Job" Placement
- **Dispatcher Context**: Under "Quick Actions" menu (not primary CTA) to prevent accidental use
- **Technician Mobile Context**: Prominent "+ New Urgent Job" button (field reality)
- **Confirmation Required**: 
  - Modal: "This will skip estimate + deposit and allow on-site payment."
  - Required field: "Urgency Reason" (text)
  - Buttons: "Cancel" / "Start Urgent Job"

#### Estimate Handling
- **Multiple Estimates per Lead**: Clearly numbered (Estimate #1, #2, etc.)
- **Visual Indication**: Show which estimate converted to which job
- **Prevent Duplicate Conversion**: "Create Job" button disabled once estimate converted, with tooltip "Job already created from this estimate"

#### Dashboard Layout
- 6-10 tiles in grid layout
- Each tile shows:
  - Count/metric (large number)
  - Label (clear text)
  - Trend indicator (optional for Phase 0)
  - Click to drill down to filtered list
- Tiles should be role-appropriate (Sales sees their data, Dispatcher sees global)

#### Reports Page
- Date range filter (default: last 30 days)
- Category tabs or accordion
- Each report has:
  - Summary metrics at top
  - Drilldown table below
  - Export to CSV (future)

#### Timeline/Activity Feed
- Show on Customer, Lead, Job detail pages
- Chronological order (newest first)
- Icon + timestamp + description + user
- Expandable for details

### Mobile Views (Technician Priority)

#### Today's Jobs List
```
┌─────────────────────────────────┐
│ Today's Jobs            [Filter]│
├─────────────────────────────────┤
│ ┌─────────────────────────────┐ │
│ │ 8:00 AM - 10:00 AM          │ │
│ │ Johnson Residence           │ │
│ │ HVAC Repair                 │ │
│ │ 📍 123 Main St              │ │
│ │ [Start Job]                 │ │
│ └─────────────────────────────┘ │
│ ┌─────────────────────────────┐ │
│ │ 11:00 AM - 1:00 PM          │ │
│ │ Smith Office Building       │ │
│ │ Plumbing Emergency          │ │
│ │ 📍 456 Oak Ave              │ │
│ │ [In Progress]               │ │
│ └─────────────────────────────┘ │
│                                 │
│ [+ New Urgent Job]              │
└─────────────────────────────────┘
```

#### Job Detail (Technician View)
```
┌─────────────────────────────────┐
│ ← Job #1234                     │
├─────────────────────────────────┤
│ Customer: Johnson Residence     │
│ 📍 123 Main St                  │
│ 📞 (555) 123-4567              │
│                                 │
│ Service Request:                │
│ AC not cooling, making noise    │
│                                 │
│ Status: [In Progress ▼]        │
│                                 │
│ Notes:                          │
│ [Add notes...]                  │
│                                 │
│ Photos: [📷 Add Photo]         │
│                                 │
│ [Mark Complete]                 │
└─────────────────────────────────┘
```

#### Urgent Job Flow (Mobile)
```
Step 1: Confirmation
┌─────────────────────────────────┐
│ Start Urgent Job?               │
├─────────────────────────────────┤
│ This will skip estimate and     │
│ deposit, allowing on-site       │
│ payment collection.             │
│                                 │
│ Urgency Reason:                 │
│ ┌─────────────────────────────┐ │
│ │ e.g., "Pipe burst, flood"   │ │
│ └─────────────────────────────┘ │
│                                 │
│ [Cancel]    [Start Urgent Job] │
└─────────────────────────────────┘

Step 2: Customer Info (minimal)
┌─────────────────────────────────┐
│ Customer Information            │
├─────────────────────────────────┤
│ Name: [____________]            │
│ Phone: [____________]           │
│ Address: [____________]         │
│                                 │
│ Service Request:                │
│ [__________________]            │
│                                 │
│ [Next: Add Charges]             │
└─────────────────────────────────┘

Step 3: Add Charges
┌─────────────────────────────────┐
│ Job Charges                     │
├─────────────────────────────────┤
│ ┌─────────────────────────────┐ │
│ │ Emergency Service           │ │
│ │ Qty: 1  $150.00    [$150]   │ │
│ └─────────────────────────────┘ │
│ ┌─────────────────────────────┐ │
│ │ Parts - Valve               │ │
│ │ Qty: 2  $45.00     [$90]    │ │
│ └─────────────────────────────┘ │
│                                 │
│ [+ Add Charge]                  │
│                                 │
│ Subtotal: $240.00               │
│ Tax (8%): $19.20                │
│ Total: $259.20                  │
│                                 │
│ [Generate Invoice]              │
└─────────────────────────────────┘

Step 4: Collect Payment
┌─────────────────────────────────┐
│ Collect Payment                 │
├─────────────────────────────────┤
│ Amount Due: $259.20             │
│                                 │
│ Payment Method:                 │
│ ○ Credit Card                   │
│ ○ Cash                          │
│                                 │
│ [Credit Card Selected]          │
│ ┌─────────────────────────────┐ │
│ │ [Stripe Card Element]       │ │
│ └─────────────────────────────┘ │
│                                 │
│ [Collect Payment]               │
└─────────────────────────────────┘
```

---

## Business Rules and Validations

### Lead Management
1. Lead must have Customer (create if new)
2. Sales rep can only edit leads assigned to them
3. Walkthrough timestamps are optional but must be logical (scheduled ≤ completed)
4. Lost leads require `lost_reason` text

### Estimate Workflow
5. Estimate can only be created from Lead in valid status
6. Multiple estimates allowed per lead
7. Estimate must have at least one line item
8. Sent estimate records `sent_at` timestamp automatically
9. Customer can approve multiple estimates simultaneously
10. Declined/Expired/Cancelled estimates remain in system (no deletion)
11. Cancelled/Withdrawn estimate requires `cancelled_reason` text
12. Estimate can only be converted to job once (enforce at DB level)

### Deposit Rules
13. Deposit can only be requested after estimate is Approved
14. Deposit amount must be > 0 and ≤ estimate total
15. Deposit payment must complete via Stripe before status = 'Paid'
16. One deposit per estimate (one-to-one relationship)

### Job Creation & Management
17. **Standard Job**: Can only be created from Approved estimate with Paid deposit
18. **Urgent Job**: Requires `urgency_reason` text, no estimate/deposit needed
19. Job auto-populates scope from estimate when created from estimate
20. Job number must be auto-generated and unique
21. Completed job requires `completed_at` timestamp
22. Cancelled job requires `cancelled_reason` and `cancelled_at`
23. Job can only be converted to invoice once

### Scheduling
24. Scheduled job must have `assigned_to` (technician)
25. Scheduled start must be < scheduled end
26. Technician can only see jobs assigned to them

### Invoicing
27. Invoice can only be created from Completed job
28. Invoice auto-applies deposit credit if job came from estimate with paid deposit
29. Invoice number must be auto-generated and unique
30. Sent invoice records `sent_at` timestamp

### Payment Collection
31. Payment must be linked to invoice
32. Payment amount must be > 0
33. Cash payments must record `collected_by` (auto-filled to current user)
34. Card payments must have `stripe_payment_intent_id`
35. Invoice status updates automatically based on payments:
    - Partial paid when 0 < paid < total
    - Paid when paid ≥ total (records `paid_at`)
36. `collected_by` is auto-filled but editable only by Dispatcher/Admin

### Permission Enforcement
37. All API endpoints must check user role and enforce permissions
38. Sales can only access leads/estimates/jobs where they are owner or creator
39. Technicians can only access jobs assigned to them
40. Dashboard/Reports filter by role automatically

---

## Stripe Integration Specification

### Environment
- Use **Stripe Test Mode** (sandbox) for Phase 0
- API keys stored as environment variables
- Webhook endpoint configured for payment events

### Payment Flows

#### 1. Deposit Payment (After Estimate Approval)
```javascript
// Frontend: Create Payment Intent
POST /api/deposits/:id/pay
{
  amount: 500.00,
  estimate_id: "uuid"
}

// Backend: Call Stripe
const paymentIntent = await stripe.paymentIntents.create({
  amount: 50000, // cents
  currency: 'usd',
  metadata: {
    deposit_id: depositId,
    estimate_id: estimateId
  }
});

// Return client_secret to frontend
// Frontend: Use Stripe Elements to collect card and confirm payment
// Webhook: Confirm payment success, update deposit.status = 'Paid'
```

#### 2. Urgent Job Payment (On-Site, Card)
```javascript
// Same flow as deposit, but:
// - metadata includes job_id, invoice_id
// - Creates Payment record linked to Invoice
// - Updates invoice status to Paid
```

#### 3. Cash Payment (Urgent Job)
```javascript
// Frontend: No Stripe call
POST /api/payments
{
  invoice_id: "uuid",
  amount: 259.20,
  method: "Cash",
  collected_by: "current_user_id" // auto-filled
}

// Backend: Create Payment record, update Invoice status
```

### Webhook Handlers
```javascript
POST /api/webhooks/stripe

// Handle events:
- payment_intent.succeeded → Update Deposit or Payment status
- payment_intent.payment_failed → Log error, notify user
```

### Error Handling
- Card declined: Show user-friendly error, allow retry
- Network error: Show "Payment processing, please wait" and poll status
- Webhook failure: Implement retry logic and manual reconciliation UI

---

## Timeline/Audit System

### Implementation Strategy
- Use `TimelineEvent` table to log all significant actions
- Auto-create events via ORM hooks or service layer
- Show chronological timeline on entity detail pages

### Event Types to Track

#### Lead Events
- `lead_created`
- `lead_assigned`
- `lead_contacted`
- `lead_walkthrough_scheduled`
- `lead_walkthrough_completed`
- `lead_won`
- `lead_lost`

#### Estimate Events
- `estimate_created`
- `estimate_sent`
- `estimate_approved`
- `estimate_declined`
- `estimate_expired`
- `estimate_cancelled`

#### Deposit Events
- `deposit_requested`
- `deposit_paid`

#### Job Events
- `job_created`
- `job_scheduled`
- `job_started`
- `job_completed`
- `job_cancelled`

#### Invoice Events
- `invoice_created`
- `invoice_sent`
- `invoice_payment_received`
- `invoice_paid`

### Timeline Display Format
```
┌─────────────────────────────────────────────┐
│ Timeline                                    │
├─────────────────────────────────────────────┤
│ ✅ Invoice paid - $259.20                   │
│    Feb 15, 2:30 PM by John Technician       │
│                                             │
│ 📄 Invoice sent - Invoice #1234             │
│    Feb 15, 1:00 PM by Sarah Dispatcher      │
│                                             │
│ ✅ Job completed - Job #5678                │
│    Feb 15, 12:45 PM by John Technician      │
│                                             │
│ 🔧 Job started                              │
│    Feb 15, 8:00 AM by John Technician       │
│                                             │
│ 📅 Job scheduled                            │
│    Feb 14, 3:00 PM by Sarah Dispatcher      │
└─────────────────────────────────────────────┘
```

---

## Development Phases & Milestones

### Phase 0.1: Foundation (Week 1-2)
- [ ] Project setup (repo, dependencies, environment)
- [ ] Database schema implementation
- [ ] Authentication system (JWT)
- [ ] User management (CRUD)
- [ ] Basic API structure with middleware

### Phase 0.2: Customer & Lead Management (Week 2-3)
- [ ] Customer CRUD endpoints
- [ ] Service location management
- [ ] Lead CRUD with assignment
- [ ] Walkthrough details capture
- [ ] Lead status transitions
- [ ] Basic UI for lead management

### Phase 0.3: Estimates & Deposits (Week 3-4)
- [ ] Estimate creation from leads
- [ ] Estimate line items
- [ ] Estimate sending (email/SMS simulation or real)
- [ ] Public estimate view for customer
- [ ] Customer approval/decline actions
- [ ] Deposit request and Stripe integration
- [ ] Deposit payment flow (sandbox)
- [ ] UI for estimate management

### Phase 0.4: Job Management (Week 4-5)
- [ ] Job creation from estimate (deposit-gated)
- [ ] Urgent job flow with confirmation
- [ ] Job charges (line items for urgent)
- [ ] Job status transitions
- [ ] Job cancellation with reason
- [ ] Scheduling interface (calendar view)
- [ ] Dispatcher job management UI
- [ ] Technician mobile UI

### Phase 0.5: Invoicing & Payments (Week 5-6)
- [ ] Invoice generation from job
- [ ] Invoice sending (email simulation or real)
- [ ] Public invoice view
- [ ] Stripe payment for urgent invoices
- [ ] Cash payment recording
- [ ] Payment history and tracking
- [ ] Invoice status management
- [ ] UI for invoice/payment workflows

### Phase 0.6: Dashboard & Reporting (Week 6-7)
- [ ] Dashboard API endpoints (all tiles)
- [ ] Dashboard UI with drilldowns
- [ ] Pipeline report
- [ ] Estimate funnel report
- [ ] Ops report (jobs by status)
- [ ] Finance report (invoices, payments)
- [ ] Sales performance report
- [ ] Closing rate calculations
- [ ] Cancellation rate reports
- [ ] Report UI with filters

### Phase 0.7: Polish & Testing (Week 7-8)
- [ ] Attachments (photo upload to S3)
- [ ] Notes system
- [ ] Timeline/audit display on detail pages
- [ ] Role-based permission enforcement review
- [ ] End-to-end testing (standard flow)
- [ ] End-to-end testing (urgent flow)
- [ ] Mobile responsiveness testing
- [ ] Stripe webhook testing
- [ ] Performance optimization
- [ ] Bug fixes and refinement

### Phase 0.8: Internal Rollout (Week 8)
- [ ] Deploy to staging environment
- [ ] Internal team training
- [ ] Documentation (user guide)
- [ ] Production deployment
- [ ] Monitor and support initial usage
- [ ] Gather feedback for Phase 1

---

## Testing Requirements

### Unit Tests
- All business logic functions
- Validation rules
- Permission checks
- Calculation functions (totals, deposit credits, etc.)

### Integration Tests
- API endpoint flows
- Database transactions
- Stripe payment flows
- Webhook handlers

### End-to-End Tests
- Standard workflow (lead → estimate → deposit → job → invoice → payment)
- Urgent workflow (lead → urgent job → charges → invoice → payment)
- Multi-estimate scenario
- Permission enforcement

### Test Data Fixtures
Create seed data:
- 3-4 Users (one of each role)
- 10-15 Customers with service locations
- 20 Leads in various statuses
- 15 Estimates (mix of statuses)
- 10 Jobs (mix of statuses)
- 5 Invoices (mix of paid/unpaid)

---

## Performance Requirements

### Response Times
- API endpoints: < 200ms (p95)
- Database queries: < 100ms (p95)
- Page loads: < 2s (p95)
- Report generation: < 3s (p95)

### Scalability Targets (Phase 0)
- Support 30 concurrent users
- Handle 1,000 leads
- Handle 500 active jobs
- 10,000 timeline events

### Optimization Strategies
- Database indexing (see Data Model section)
- Query optimization (avoid N+1)
- Pagination on all list endpoints (default 50 items)
- Caching for dashboard stats (5-minute TTL)

---

## Security Requirements

### Authentication & Authorization
- JWT tokens with 1-hour expiration
- Refresh token rotation
- Password requirements: 8+ chars, mixed case, number, symbol
- HTTPS only (even in development with self-signed cert)

### Data Protection
- Passwords hashed with bcrypt (cost factor 12)
- Sensitive data encrypted at rest (database encryption)
- File uploads scanned for malware (future)
- SQL injection prevention (use parameterized queries)
- XSS prevention (sanitize inputs, CSP headers)

### API Security
- Rate limiting (100 requests/minute per user)
- CORS configuration (whitelist frontend domain)
- Input validation on all endpoints (use Zod or Joi)
- CSRF protection for state-changing operations

### Audit & Compliance
- Log all authentication attempts
- Log all permission-denied events
- Timeline tracks all data changes
- Soft delete for critical entities (future)

---

## Environment Variables

```bash
# Application
NODE_ENV=development
PORT=3000
API_BASE_URL=http://localhost:3000

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/alpha_crm_dev

# JWT
JWT_SECRET=your-super-secret-jwt-key-change-this
JWT_REFRESH_SECRET=your-refresh-secret-key
JWT_EXPIRATION=1h
JWT_REFRESH_EXPIRATION=7d

# Stripe (Test Mode)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# File Storage (S3 or compatible)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET=alpha-crm-attachments-dev
AWS_S3_REGION=us-east-1

# Email (for sending estimates/invoices)
# Use SMTP or service like SendGrid/Postmark
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password

# SMS (optional, for sending estimate/invoice links)
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=...

# Frontend
REACT_APP_API_URL=http://localhost:3000/api
REACT_APP_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

---

## Deployment Specification

### Development Environment
- Local development: Docker Compose with PostgreSQL + Redis
- Hot reload enabled
- Detailed error logging
- Debug tools enabled

### Staging Environment
- Cloud hosting (AWS, GCP, or Heroku)
- Database: Managed PostgreSQL (RDS, Cloud SQL, or Heroku Postgres)
- File storage: S3 or compatible
- Environment: Staging/test mode
- Access: Internal team only

### Production Environment (Phase 1+)
- Load balancer for API servers
- Database replication for high availability
- CDN for static assets
- Automated backups (daily, 30-day retention)
- Monitoring and alerting (Sentry, DataDog, etc.)
- SSL certificates (Let's Encrypt or similar)

---

## Out of Scope for Phase 0

### Explicitly Not Included
- ❌ Data imports/migrations from other systems
- ❌ Two-way SMS inbox
- ❌ Customer portal (self-service booking/approvals)
- ❌ Automation rules or AI features
- ❌ Route optimization, GPS tracking, offline mobile mode
- ❌ Inventory management system
- ❌ Asset tracking
- ❌ Advanced BI/forecasting
- ❌ Third-party integrations (QuickBooks, etc.)
- ❌ Public API for external developers
- ❌ Multi-company/multi-tenant support
- ❌ White-label customization
- ❌ Advanced permissions (custom roles)

---

## Success Criteria for Phase 0

Phase 0 is considered **successful** when:

1. ✅ Internal team can manage **10+ standard jobs** end-to-end in ALPHA CRM without critical blockers
2. ✅ **5+ urgent jobs** handled on-site with successful payment collection (mix of card and cash)
3. ✅ **Deposit gating** prevents job creation without payment (zero violations)
4. ✅ **Dashboard + Reports** support weekly business review:
   - Sales performance by rep
   - Closing rates (approved/sent, won/total)
   - Cancellation/withdrawal rates
   - Cash collected
   - Job throughput
5. ✅ **No data loss** or corruption incidents
6. ✅ **Stripe payments** (sandbox) work reliably (95%+ success rate)
7. ✅ **Timeline/Audit** accurately reflects all major events
8. ✅ **Mobile experience** for technicians is usable and efficient
9. ✅ Team provides feedback indicating ALPHA CRM is **preferred** over current tools for core workflows
10. ✅ Leadership identifies **clear Phase 1 priorities** based on real usage data

---

## Development Best Practices for AI Tools

### Code Organization
```
/backend
  /src
    /controllers      # API route handlers
    /services         # Business logic
    /models           # Database models (ORM)
    /middleware       # Auth, validation, error handling
    /utils            # Helper functions
    /config           # Configuration files
    /validators       # Input validation schemas
  /tests              # Unit and integration tests
  /prisma             # Database schema and migrations (if using Prisma)
  
/frontend
  /src
    /components       # Reusable UI components
    /pages            # Page-level components
    /features         # Feature-specific modules
    /hooks            # Custom React hooks
    /services         # API client functions
    /utils            # Helper functions
    /types            # TypeScript type definitions
    /contexts         # React Context providers
  /public             # Static assets
```

### Naming Conventions
- **Files**: kebab-case (e.g., `user-controller.ts`, `estimate-form.tsx`)
- **Components**: PascalCase (e.g., `EstimateCard`, `JobScheduler`)
- **Functions**: camelCase (e.g., `createEstimate`, `calculateTotal`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `MAX_FILE_SIZE`, `DEFAULT_TAX_RATE`)
- **Database tables**: snake_case (e.g., `estimate_line_items`, `timeline_events`)

### Git Workflow
- **Branch naming**: `feature/add-deposit-flow`, `bugfix/invoice-calculation`
- **Commit messages**: Conventional Commits format
  - `feat: add urgent job creation endpoint`
  - `fix: correct deposit credit calculation in invoice`
  - `refactor: simplify permission checking middleware`
- **Pull requests**: Descriptive title, link to requirements, checklist for testing

### Code Comments
- Document complex business logic
- Explain non-obvious decisions
- Add TODO comments with context
- Use JSDoc for function documentation

### Error Handling
- Use consistent error response format:
  ```json
  {
    "error": {
      "code": "DEPOSIT_REQUIRED",
      "message": "Cannot create job: deposit not paid",
      "details": { "estimate_id": "uuid", "deposit_status": "Requested" }
    }
  }
  ```
- Log errors with context (user, action, timestamp)
- Never expose sensitive data in error messages

### Testing Commands
```bash
# Backend
npm run test              # Run all tests
npm run test:watch        # Watch mode
npm run test:coverage     # Coverage report

# Frontend
npm run test              # Run all tests
npm run test:e2e          # End-to-end tests
```

---

## AI Tool Integration Notes

### For Claude Code / Cursor / Codex

When developing ALPHA CRM, follow this **systematic approach**:

1. **Start with data model**: Implement database schema first (migrations, models)
2. **Build API layer**: Create endpoints following REST conventions
3. **Add business logic**: Implement service layer with validations
4. **Create UI components**: Build frontend features incrementally
5. **Test continuously**: Write tests alongside code
6. **Iterate**: Refine based on feedback

### Prompting Strategy

**Good prompt example**:
```
Implement the Estimate creation endpoint:
- POST /api/estimates
- Accept: lead_id, line_items (array), scope_notes
- Validate: lead exists and is in valid status
- Business rules: at least one line item, calculate totals
- Permissions: Sales can only create for assigned leads
- Return: created estimate with auto-generated estimate_number
- Include unit tests for validation and calculation logic
```

**Context to provide**:
- Relevant section from this spec
- Related database schema
- Existing code patterns to follow
- Expected input/output examples

### Incremental Development

Build features in **vertical slices**:
1. Database migration for new entity
2. API endpoint(s)
3. Service layer logic
4. UI component
5. Integration test

This ensures each feature is complete and testable before moving to the next.

---

## Glossary

- **Lead**: Potential customer inquiry or opportunity
- **Estimate**: Formal quote/proposal sent to customer
- **Deposit**: Partial payment required before work begins (standard flow)
- **Job**: Scheduled work assignment for technician
- **Urgent Job**: Emergency service without estimate/deposit
- **Invoice**: Final bill after work completion
- **Payment**: Money collected (card or cash)
- **Timeline Event**: Audit log entry for tracking changes
- **Walkthrough**: Site visit to assess work before creating estimate

---

## Questions for Clarification (Address Before Starting)

1. **Email/SMS sending**: Should Phase 0 send real emails/SMS, or use mock/logging?
   - Recommendation: Use real SMTP for emails, log SMS for Phase 0
   
2. **Tax calculation**: Fixed rate or configurable per location?
   - Recommendation: Single configurable tax rate for Phase 0
   
3. **Estimate expiration**: Auto-expire after X days, or manual only?
   - Recommendation: Manual only for Phase 0; add auto-expire in Phase 1
   
4. **Scheduling conflicts**: Should system prevent double-booking technicians?
   - Recommendation: Warning only (not hard block) for Phase 0
   
5. **File upload limits**: Max file size and file types?
   - Recommendation: 10MB per file, images only (jpg, png) for Phase 0
   
6. **Estimate numbering**: Format preference (e.g., EST-2024-0001)?
   - Recommendation: EST-{YYYY}-{sequential} with zero-padding
   
7. **Job numbering**: Same format as estimates?
   - Recommendation: JOB-{YYYY}-{sequential}
   
8. **Invoice numbering**: Same pattern?
   - Recommendation: INV-{YYYY}-{sequential}

---

## Appendix: Example Data Flow

### Standard Flow Example

```
1. Dispatcher creates Lead
   Lead #L-2024-0042
   Customer: ABC Plumbing Services
   Service Request: "Kitchen sink leak"
   
2. Dispatcher assigns to Sales Rep (Sarah)
   
3. Sarah schedules walkthrough
   Walkthrough scheduled: Feb 20, 10:00 AM
   
4. Sarah completes walkthrough, adds notes
   Walkthrough completed: Feb 20, 10:45 AM
   Notes: "Main shut-off valve corroded, recommend replacement"
   Photos: [valve-photo-1.jpg, valve-photo-2.jpg]
   
5. Sarah creates Estimate
   Estimate #EST-2024-0089
   Line items:
     - Valve replacement: 1 x $150 = $150
     - Labor (2 hours): 2 x $85 = $170
   Subtotal: $320
   Tax (8%): $25.60
   Total: $345.60
   
6. Sarah sends Estimate
   sent_at: Feb 20, 3:00 PM
   
7. Customer approves via link
   approved_at: Feb 21, 9:00 AM
   
8. Dispatcher requests Deposit (50%)
   Deposit amount: $172.80
   requested_at: Feb 21, 9:15 AM
   
9. Customer pays Deposit via Stripe
   paid_at: Feb 21, 10:00 AM
   stripe_payment_intent_id: pi_1234...
   
10. Dispatcher creates Job from Estimate
    Job #JOB-2024-0156
    Auto-populated from estimate
    
11. Dispatcher schedules Job
    Assigned to: John (Technician)
    Scheduled: Feb 22, 2:00 PM - 4:00 PM
    
12. John starts Job
    status: In Progress
    started_at: Feb 22, 2:15 PM
    
13. John completes Job
    status: Completed
    completed_at: Feb 22, 3:30 PM
    Notes: "Valve replaced, tested for leaks, all clear"
    
14. Dispatcher generates Invoice
    Invoice #INV-2024-0198
    Subtotal: $320
    Tax: $25.60
    Deposit credit: -$172.80
    Total: $345.60
    Amount due: $172.80
    
15. Dispatcher sends Invoice
    sent_at: Feb 22, 4:00 PM
    
16. Customer pays remaining balance
    Payment method: Card
    Amount: $172.80
    paid_at: Feb 23, 10:00 AM
    
17. Invoice marked Paid
    status: Paid
```

### Urgent Flow Example

```
1. Technician (John) arrives at emergency site
   Customer: XYZ Restaurant
   Issue: "Grease trap overflow, health inspector on site"
   
2. John creates Lead on mobile
   Lead #L-2024-0043
   Customer: XYZ Restaurant (new)
   Phone: (555) 987-6543
   Service Request: "Grease trap overflow emergency"
   
3. John clicks "Start Urgent Job"
   Confirmation modal appears
   John enters Urgency Reason: "Grease trap overflow, health inspector present, requires immediate service"
   Confirms
   
4. System creates Job (urgent)
   Job #JOB-2024-0157
   is_urgent: true
   urgency_reason: "Grease trap overflow, health inspector present..."
   status: In Progress
   
5. John performs work and adds charges
   Job Charges:
     - Emergency service call: 1 x $200 = $200
     - Grease trap cleaning: 1 x $350 = $350
     - Enzyme treatment: 2 x $40 = $80
   Subtotal: $630
   Tax (8%): $50.40
   Total: $680.40
   
6. John generates Invoice on mobile
   Invoice #INV-2024-0199
   Amount due: $680.40
   
7. John collects payment (Card)
   Uses Stripe mobile terminal on phone
   Customer taps card
   
8. Payment confirmed
   Payment method: Card
   Amount: $680.40
   collected_by: John (auto-filled)
   paid_at: Feb 22, 5:45 PM
   
9. Invoice marked Paid
   status: Paid
   
10. Job marked Completed
    status: Completed
    completed_at: Feb 22, 5:45 PM
```

---

## Final Notes for AI Development Tools

This specification is designed to be **comprehensive yet flexible**. When implementing:

- **Prioritize working software** over perfect code
- **Validate assumptions early** with quick prototypes
- **Test business rules** thoroughly (they prevent revenue loss)
- **Keep UI simple** for Phase 0; polish later
- **Document decisions** and trade-offs in code comments
- **Ask clarifying questions** when spec is ambiguous

The goal is a **functional MVP** that proves the concept and guides Phase 1. Perfect is the enemy of good. Ship it, learn from it, iterate.

**Good luck building ALPHA CRM!** 🚀
