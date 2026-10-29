# ALPHA CRM - Phase 0 MVP Development Plan

## Project Overview

**ALPHA CRM** is a multi-tenant SaaS field service management platform for SMB contractors (5-30 technicians) in HVAC, plumbing, electrical, and related trades.

**Target:** Companies outgrown Jobber but can't afford ServiceTitan. Pricing: $49/$179/$349 per account, unlimited users.

---

## Core Workflows

### Standard Flow (Deposit-Gated)
```
Lead (manual) → Estimate(s) → Customer Signs & Approves → Deposit Paid →
Office clicks "Create Job" → Schedule → Tech Completes → Invoice → Payment
```

### Urgent Flow (Emergency Jobs)
```
Create Lead → Start Urgent Job → Tech adds line items during job →
Invoice generated → Payment (on-site or later)
```

---

## Tech Stack (from Dev Spec)

| Layer | Technology |
|-------|------------|
| **Frontend** | React 18 + TypeScript + Vite, shadcn/ui, Tailwind CSS, TanStack Query, Zustand |
| **Backend** | Node.js 20 + Express + TypeScript, Prisma ORM, Zod validation |
| **Database** | Supabase PostgreSQL (multi-tenant) |
| **Auth** | Supabase Auth (email/password + Google OAuth + password reset) |
| **Payments** | Stripe test mode (online) + manual recording (cash/check) |
| **Storage** | Supabase Storage (photos, attachments) |
| **Email** | Resend (transactional emails for estimates/invoices) |
| **PDFs** | Server-side generation (PDFKit or Puppeteer) |
| **Signatures** | Canvas-based drawing (finger/mouse) |
| **Currency** | USD only |
| **Timezone** | Company-wide setting (single timezone per company) |
| **SMS** | Not in MVP (email only) |
| **Hosting** | Vercel (frontend), Railway (backend) |

---

## MVP Modules & Features

### 1. Authentication & Users
- Supabase Auth: email/password, Google OAuth, password reset
- Roles: Owner/Admin, Office Manager, Technician
- User management: invite, deactivate
- Multi-tenant: each company has isolated data

### 2. Company Settings
- Company name, logo
- Default tax rate
- Default payment terms
- User management

### 3. Dashboard (Role-Based)
- **Owner/Admin**: Full KPIs, all action queues, revenue metrics
- **Office Manager**: Today's jobs, pending deposits, overdue invoices, workload
- **Technician**: Today's assigned jobs only

### 4. Leads (Manual Entry)
- Create: name, phone, email, address, service request, notes
- Statuses: New → Contacted → Estimating → Won → Lost
- Convert to customer (or auto-create on lead creation)

### 5. Customers
- Profile: contacts + multiple service locations
- Notes, search
- Duplicate detection: block creation if phone/email exists
- History timeline: leads, estimates, jobs, invoices, payments

### 6. Estimates
- Create from lead/customer
- Line items (service, qty, unit price), totals, taxes/discounts
- Photo attachments + notes
- Statuses: Draft → Sent → Approved / Declined / Expired
- Multiple estimates per lead, only ONE can be Approved
- Send via email link (Resend) - no SMS in MVP
- Customer approval: Link → View → **Draw signature on canvas** → Approve
- PDF generation (server-side)

### 7. Deposits (Job Gate)
- Request only after estimate Approved
- Customer pays via Stripe payment link
- Statuses: Requested → Paid
- **Hard gate**: no job creation until deposit paid (except Urgent Flow)
- Deposit recorded and applied as credit to final invoice

### 8. Jobs
- **Standard**: Office clicks "Create Job" after deposit paid, auto-populates from estimate
- **Urgent**: Created directly, tech adds line items during job
- Statuses: Unassigned → Scheduled → In Progress → Completed
- Assign technician(s)
- Job notes, attachments

### 9. Scheduling
- Week view calendar
- Unassigned jobs queue
- Assign tech + time window
- In-app notification on assignment/changes

### 10. Technician Experience (Responsive Web)
- Today's jobs list
- Job detail view (full customer contact info: phone, email, address)
- Update job status
- Add notes + photos
- Add line items (Urgent Flow)
- Completion confirmation with optional signature

### 11. Invoicing
- Generate from completed job
- Apply deposit as credit automatically
- Statuses: Draft → Sent → Paid
- Send via email link (Resend) - no SMS in MVP
- PDF generation (server-side)

### 12. Payments
- **Online**: Stripe payment links
- **Manual**: Record cash/check payments
- Payment recorded with method type
- Receipt confirmation

### 13. Notifications
- In-app only (notification bell)
- Events: job assigned, job status changed, estimate approved, payment received

### 14. Reports (Filtered List Views + Totals)
- **Pipeline**: Leads by status, won vs lost, estimate funnel, estimate aging
- **Deposits**: Awaiting deposit, deposits collected, deposit-to-job conversion queue
- **Operations**: Jobs by status, unassigned queue, scheduled jobs, tech workload
- **Finance**: Outstanding invoices, aging buckets (0-7/8-30/31-60/60+), payments received
- **Usage**: Counts over time, cycle-time averages

### 15. Help Features (Minimal)
- In-app help entry point (link to docs)
- Basic FAQs / quick start guides
- Onboarding checklist (company setup, add techs, first lead/estimate)

---

## Explicit MVP Exclusions

- Import/export & migrations (Phase 1.5)
- SMS sending (email only in MVP)
- Two-way SMS/inbox
- Customer portal
- Automations/workflow builder
- Route optimization, GPS, offline mode
- Inventory, equipment assets
- Advanced custom report builder
- Integrations/API
- AI features
- Multi-currency (USD only)
- Stripe Connect (test mode only, production payment routing later)

---

## Build Order

### Phase A: Foundation
1. Project setup (monorepo, frontend, backend, database)
2. Supabase project setup (DB, Auth, Storage)
3. Prisma schema design (multi-tenant)
4. Authentication (login, register, Google OAuth, password reset)
5. User & role management
6. Company settings

### Phase B: Core Workflow
7. Customers (CRUD, duplicate detection, search)
8. Leads (CRUD, status transitions)
9. Estimates (CRUD, line items, attachments, PDF generation)
10. Estimate approval flow (public link, signature, status update)
11. Deposits (request, Stripe payment link, status tracking)
12. Jobs - Standard flow (create from estimate, deposit gate)
13. Jobs - Urgent flow (direct creation, line items during job)
14. Job management (status updates, notes, photos, completion)

### Phase C: Operations
15. Scheduling (calendar, unassigned queue, assignment)
16. Technician views (today's jobs, job detail, mobile-optimized)
17. Invoicing (generate from job, apply deposit, PDF)
18. Payments (Stripe integration, manual recording)
19. In-app notifications

### Phase D: Insights
20. Role-based dashboards
21. Reports (pipeline, deposits, operations, finance)
22. Help features (onboarding checklist, FAQs)

---

## Database Schema (Key Entities)

```
Tenant (company)
├── User (role: admin/office_manager/technician)
├── Customer
│   └── ServiceLocation
├── Lead → Customer
├── Estimate → Lead/Customer
│   ├── EstimateLineItem
│   └── EstimateAttachment
├── Deposit → Estimate
├── Job → Estimate (optional for urgent)
│   ├── JobLineItem (for urgent jobs)
│   ├── JobAttachment
│   └── JobAssignment → User (technician)
├── Invoice → Job
│   └── InvoiceLineItem
└── Payment → Invoice
```

---

## Verification Plan

1. **Auth**: Register, login, Google OAuth, password reset, role-based access
2. **Standard Flow**: Lead → Estimate → Approve → Deposit → Job → Complete → Invoice → Pay
3. **Urgent Flow**: Lead → Urgent Job → Add items → Invoice → Pay
4. **Technician View**: Mobile-responsive, see assigned jobs, update status, add photos
5. **Reports**: Verify all report views show correct filtered data
6. **Multi-tenant**: Verify data isolation between companies

---

## Files to Create

```
alpha-crm/
├── frontend/                 # React + Vite + TypeScript
├── backend/                  # Express + Prisma + TypeScript
├── package.json              # Root workspace
├── .env.example              # Environment template
└── README.md                 # Setup instructions
```

See ALPHA_CRM_MVP_Development_Spec.md for detailed file structure.
