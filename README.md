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

- Node.js 20+
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

3. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your credentials
```

4. Set up the database:
```bash
cd backend
npm run prisma:generate
npm run prisma:migrate
```

5. Start development servers:
```bash
# From root directory
npm run dev
```

This starts both frontend (http://localhost:5173) and backend (http://localhost:3001).

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
- `npm run dev` - Start both frontend and backend
- `npm run build` - Build both packages
- `npm run test` - Run all tests

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
