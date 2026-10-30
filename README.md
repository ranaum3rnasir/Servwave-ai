# ALPHA CRM

Field service management platform for SMB contractors (5-30 technicians) in HVAC, plumbing, electrical, and related trades.

## Tech Stack

- **Frontend:** React 18 + TypeScript + Vite, shadcn/ui, Tailwind CSS, TanStack Query, Zustand
- **Backend:** Node.js 20 + Express + TypeScript, Prisma ORM, Zod validation
- **Database:** Supabase PostgreSQL
- **Auth:** Supabase Auth (email/password + Google OAuth)
- **Payments:** Stripe (test mode)
- **Storage:** Supabase Storage
- **Email:** Resend

## Prerequisites

- Node.js 22+ (see `.nvmrc`)
- npm 9+
- Supabase account
- Stripe account (test mode)
- Resend account

## Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd alpha-crm
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables. Each app loads its own `.env` from its own
   directory (not the repo root):
```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# Edit both with your credentials
```

4. Generate the Prisma client:
```bash
cd backend
npm run prisma:generate
```
   Do **not** run `npm run prisma:migrate` (`prisma migrate dev`) against a
   shared Supabase project (e.g. the staging DB) — it builds a shadow database
   to diff against and can mutate shared data. Check whether migrations are
   already applied with `npx prisma migrate status` instead; only run
   `prisma:migrate` against your own local/throwaway database.

5. Start development servers (two terminals, from the root directory):
```bash
npm run dev:backend   # http://localhost:3000
npm run dev:frontend  # http://localhost:5173
```

## Project Structure

```
alpha-crm/
├── frontend/           # React + Vite + TypeScript
│   └── src/
│       ├── components/ # Reusable UI components
│       ├── features/   # Feature modules
│       ├── hooks/      # Custom React hooks
│       ├── lib/        # Utilities
│       ├── services/   # API client functions
│       └── types/      # TypeScript definitions
├── backend/            # Express + Prisma + TypeScript
│   ├── prisma/         # Schema + migrations
│   └── src/
│       ├── controllers/# Route handlers
│       ├── middleware/ # Auth, validation
│       ├── services/   # Business logic
│       ├── routes/     # API endpoints
│       ├── validators/ # Zod schemas
│       └── types/      # TypeScript types
└── package.json        # Root workspace config
```

## Available Scripts

### Root
- `npm run dev:backend` / `npm run dev:frontend` - Start each app (run both, in separate terminals)
- `npm run build:backend` / `npm run build:frontend` - Build each package
- `npm run lint` - Lint all workspaces

### Frontend (from /frontend)
- `npm run dev` - Start Vite dev server
- `npm run build` - Build for production
- `npm run lint` - Run ESLint
- `npm run test` - Run tests

### Backend (from /backend)
- `npm run dev` - Start with hot reload
- `npm run build` - Compile TypeScript
- `npm run prisma:studio` - Open Prisma Studio

## User Roles

- **Owner/Admin:** Full access to all features
- **Office Manager:** Leads, estimates, jobs, invoices, reports
- **Technician:** Assigned jobs only, mobile-optimized view

## Core Workflow

```
Lead → Estimate → Approval → Deposit → Job → Complete → Invoice → Payment
```

## License

Proprietary - All rights reserved
