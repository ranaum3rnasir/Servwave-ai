# Technical Design: ServWave Spider AI Lead Watcher Server Engine

**Document Version:** 1.0.0  
**Author:** ServWave AI Farm Engineering Team  
**Status:** Approved Technical Design  
**Target File:** `ai-work/spider-server-engine-design.md`

---

## 1. Executive Summary & Purpose

The **Spider AI Lead Watcher** is an automated pipeline monitoring engine within the ServWave AI Farm. It continuously tracks the time customer leads spend in each pipeline stage, compares that elapsed duration against customizable organization thresholds, and dispatches multi-channel alerts (In-App Popup, Red Ambient Frame, Email, and Staff SMS) to designated staff roles, specific users, or lead owners.

This technical design defines the server-side engine architecture, canonical data schemas, deduplication mechanics, activation time bounds, and frontend alert delivery protocols. It formalizes the contract between the background sweep job and the user interface.

---

## 2. System Architecture & Component Overview

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 SERVWAVE BACKEND                                       │
│                                                                                        │
│  ┌───────────────────────┐         ┌────────────────────────────────────────────────┐  │
│  │ SpiderWatcherCron Job │ ───┐     │           Database (PostgreSQL)                │  │
│  │ (Scheduled Sweeper)   │    │     │                                                │  │
│  └───────────────────────┘    ├───► │ • spider_watcher_configs (is_active, thresholds)│ │
│                               │     │ • spider_alert_logs (dedupe_key, audit trail)  │  │
│  ┌───────────────────────┐    │     │ • notifications & notification_recipients      │  │
│  │ SpiderDispatchService │ ───┘     │ • leads & lead_stage_history                   │  │
│  │ (Alert Dispatcher)    │          └────────────────────────────────────────────────┘  │
│  └───────────┬───────────┘                                   │                         │
└──────────────┼───────────────────────────────────────────────┼─────────────────────────┘
               │                                               │
               ▼                                               ▼ REST API / Events
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 SERVWAVE FRONTEND                                      │
│                                                                                        │
│  ┌─────────────────────────┐   ┌──────────────────────────┐   ┌─────────────────────┐  │
│  │ SpiderNotificationPopup │   │ BrowserAutomationIndicator│  │  SpiderConfigPanel  │  │
│  │ (Floating Lead Cards)   │   │ (Pulsing Red Frame)      │   │  (Threshold Admin)  │  │
│  └─────────────────────────┘   └──────────────────────────┘   └─────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Core Components

1. **`spiderWatcherCron.ts` (Sweeper Worker)**: A server-side scheduled background worker running periodically (e.g. every 2 minutes). It queries all organizations where Spider is active, evaluates open leads against configured stage thresholds, and invokes dispatch with deterministic deduplication keys.
2. **`spiderDispatch.service.ts` (Dispatch Engine)**: Executes tenant-isolated lead lookups, resolves assigned recipients (Owner, System Roles, Users), and emits multi-channel alerts (Stateless Staff SMS, Approved Sender Email, and DB-backed In-App Events).
3. **`aiFarm.controller.ts` & `aiFarm.routes.ts` (API Endpoints)**: Secure endpoints for reading/updating Spider configurations (`/api/ai-farm/spider/config`) and viewing paginated alert logs (`/api/ai-farm/spider/logs`) with RBAC enforcement (`ADMIN` role required).
4. **`SpiderNotificationPopup.tsx` & `BrowserAutomationIndicator.tsx` (UI Clients)**: Frontend components that render server-emitted in-app notifications and ambient frame indicators directly from server state (`/api/notifications`).

---

## 3. Stage Keys and Units (Item 1)

### 3.1. Canonical Stage Keys
To eliminate schema drift between the UI configuration forms and the background sweep worker, Spider defines three canonical stage keys:

| Canonical Stage Key (`stageId`) | Stage Display Label | Pipeline Transition | Trigger Description |
| :--- | :--- | :--- | :--- |
| `new-contacted` | `New → Contacted` | `New` $\rightarrow$ `Contacted` | Lead created but customer has not been contacted (`contacted_at IS NULL`). |
| `contacted-walkthrough-scheduled` | `Contacted → Walkthrough Scheduled` | `Contacted` $\rightarrow$ `Walkthrough Scheduled` | Lead contacted, but walkthrough has not been booked (`walkthrough_first_booked_at IS NULL`). |
| `walkthrough-completed-estimate` | `Walkthrough Completed → Estimate` | `Walkthrough Completed` $\rightarrow$ `Estimate` | Onsite walkthrough completed (`last_visit_completed_at IS NOT NULL`), but estimate has not been sent (`first_estimate_sent_at IS NULL`). |

### 3.2. Canonical Threshold Units
Threshold units are standardized across frontend steppers, backend serializers, and database columns:

| Unit Key | Multiplier (Milliseconds) | Multiplier (Seconds) | Common Usage |
| :--- | :--- | :--- | :--- |
| `Second` | $1,000\text{ ms}$ | $1\text{ s}$ | Development and integration testing |
| `Minute` | $60,000\text{ ms}$ | $60\text{ s}$ | Rapid testing and fast-response pipelines |
| `Hour` | $3,600,000\text{ ms}$ | $3,600\text{ s}$ | High-priority commercial leads |
| `Day` | $86,400,000\text{ ms}$ | $86,400\text{ s}$ | Standard sales pipeline operations (Default) |
| `Week` | $604,800,000\text{ ms}$ | $604,800\text{ s}$ | Long-tail enterprise follow-ups |

### 3.3. Shared Serialization Contract
The configuration is persisted in PostgreSQL in the `spider_watcher_configs.stage_thresholds` JSON column using the following strict schema:

```json
{
  "new-contacted": {
    "value": 2,
    "unit": "Day",
    "enabled": true
  },
  "contacted-walkthrough-scheduled": {
    "value": 4,
    "unit": "Hour",
    "enabled": true
  },
  "walkthrough-completed-estimate": {
    "value": 24,
    "unit": "Hour",
    "enabled": true
  }
}
```

* **Backward Compatibility & Aliases**: The backend sweeper (`spiderWatcherCron.ts`) resolves thresholds using canonical keys first (`new-contacted`), falling back gracefully to legacy short keys (`new`, `contacted`, `estimate`) if present in older records.

---

## 4. Dedupe Key & Deduplication Window (Item 2)

### 4.1. Dedupe Key Format
To prevent repeated background sweep cycles from generating duplicate alerts, every alert dispatch generates a deterministic `dedupe_key`:

$$\text{dedupe\_key} = \text{spider}:\{\text{organizationId}\}:\{\text{leadId}\}:\{\text{stageKey}\}:\{\text{stageStartDay}\}:\{\text{thresholdValue}\}\{\text{thresholdUnit}\}$$

* **Components**:
  * `spider`: Static namespace prefix.
  * `organizationId`: Tenant UUID ensuring multi-tenant isolation.
  * `leadId`: UUID of the lead breaching the threshold.
  * `stageKey`: Canonical stage key (e.g. `new-contacted`).
  * `stageStartDay`: ISO date string (`YYYY-MM-DD`) representing the date the lead entered the stage.
  * `thresholdValue` + `thresholdUnit`: Configured threshold threshold identifier (e.g. `2Day`).

* **Example**:
  `spider:00000000-0000-4000-a000-000000000001:22222222-2222-4000-a000-222222222222:new-contacted:2026-10-08:2Day`

### 4.2. Deduplication Storage & Enforcement
1. **Pre-Dispatch Database Check**: Before initiating any outbound dispatch (email/SMS/in-app), `spiderWatcherCron.ts` executes:
   ```typescript
   const existingLog = await prisma.spiderAlertLog.findUnique({
     where: { dedupe_key: dedupeKey },
     select: { id: true },
   });
   if (existingLog) return; // Skip dispatch
   ```
2. **Database Unique Constraint**: `SpiderAlertLog.dedupe_key` is backed by a `@unique` PostgreSQL index (`@@unique([dedupe_key])`). If concurrent workers race on the same lead, the database enforces row uniqueness.
3. **In-App Notification Window**: For real-time in-app events, the `dedupKey` is attached to `NotificationRecipient.dedup_key` with a 30-minute deduplication window (`Math.floor(Date.now() / 1800000)`), preventing UI spam.

---

## 5. Activation-Time Floor (Item 3)

### 5.1. The Stale Lead Avalanche Problem
When a company with hundreds of existing leads activates Spider for the first time, leads that have been in `NEW` stage for 30 days would immediately breach a "2 Day" threshold simultaneously. Firing 500 simultaneous SMS/emails on day 1 would overwhelm staff and violate rate limits.

### 5.2. Activation Floor Specification
To prevent historical backlog avalanches upon activation:

1. **Activation Timestamp**: When Spider is activated (`is_active = true`), the engine persists `activated_at = NOW()` in `spider_watcher_configs`.
2. **Effective Stage Entrance Floor**: The effective stage start timestamp used for elapsed duration evaluation is floored by the activation time:
   $$\text{effectiveStageStart} = \max(\text{lead.stage\_entered\_at}, \text{config.activated\_at})$$
3. **Evaluation Logic**:
   * If a lead entered `NEW` stage on **October 1**, and Spider is activated on **October 8** with a **2 Day** threshold:
     * $\text{effectiveStageStart} = \text{October 8}$
     * The lead will trigger an alert on **October 10** (2 days after activation), rather than firing instantly on October 8.
4. **Implementation Gap Note**: Currently, `spider_watcher_configs` relies on `updated_at` when toggled. A dedicated explicit `activated_at DateTime?` column is specified in Prisma schema migrations to track distinct re-activation epochs.

---

## 6. Popup & Ambient Frame Alert Delivery (Item 4)

### 6.1. Alert Emission & Database Persistence
Spider alerts do not rely on fragile browser polling loops or client-side `localStorage`. All alerts follow a persistent server event model:

```
┌─────────────────────────┐
│ spiderDispatch.service  │
└────────────┬────────────┘
             │ emit('spider.alert', payload)
             ▼
┌────────────────────────────────────────────────────────┐
│ Central Notification Service                           │
│ • Inserts into notifications table                     │
│ • Inserts into notification_recipients table (read_at) │
└────────────┬───────────────────────────────────────────┘
             │
      ┌──────┴─────────────────────────┐
      ▼ (REST API)                     ▼ (WebSocket / Polling)
┌───────────────────────────┐   ┌───────────────────────────┐
│ SpiderNotificationPopup   │   │ BrowserAutomationIndicator│
│ (Unread Cards UI)         │   │ (Red Pulsing Frame)       │
└───────────────────────────┘   └───────────────────────────┘
```

### 6.2. Popup Component (`SpiderNotificationPopup.tsx`)
* **Data Fetching**: Queries `/api/notifications?verb=spider.alert&unread=true` via React Query (`staleTime: 30000`).
* **Unread Counter**: Displays the actual unread badge count from the database (`NotificationRecipient.read_at IS NULL`).
* **Display Details**: Formats customer name, lead number, lead stage, complete service address, assigned owner, and elapsed inactive time.

### 6.3. Ambient Red Frame Indicator (`BrowserAutomationIndicator.tsx`)
* **Visual Alert**: Renders a fixed, pulsing red viewport border (`border-4 border-destructive/80 animate-pulse pointer-events-none`) around the CRM window.
* **Activation Conditions**: Displays only when:
  1. The organization has `notifications.redFrame: true` enabled;
  2. The logged-in user has at least one active, unread Spider alert in `notification_recipients`.

### 6.4. Lifecycle & Session Transitions
* **Page Refresh & Re-login**: Because unread state is stored in PostgreSQL (`notification_recipients.read_at`), refreshing the page, opening a new tab, or logging in on a different machine immediately restores the exact unread cards and red frame status.
* **Marking as Read**:
  * Clicking an alert card or navigating to the lead Overview triggers `markNotificationRead(notificationId)`, updating `NotificationRecipient.read_at = NOW()`.
  * If a lead moves to the `Estimate` stage, associated Spider notifications are automatically marked as read.
  * When all alerts are read, the popup clears and the ambient red frame turns off automatically.
* **Deactivation**: When Spider is deactivated (`is_active = false`), background sweeping stops immediately. Existing unread notifications remain readable in user inbox history until acknowledged, and historical logs remain accessible in `/api/ai-farm/spider/logs`.

---

## 7. Security, Tenant Isolation & RBAC

1. **Strict Tenant Isolation (SEC-2)**: Every lead query and alert log lookup includes mandatory `where: { organization_id: session.organizationId }`.
2. **Authenticated Access (SEC-1)**: All `/api/ai-farm/spider/*` routes require authenticated session tokens (`requireAuth`).
3. **Role-Based Access Control (SEC-8)**: Only administrators (`ADMIN` role) can update configuration (`PUT /api/ai-farm/spider/config`). Non-admin roles (Sales, Dispatcher, Technician) receive HTTP 403 Forbidden.
4. **Stateless Staff-Only SMS (SEC-4)**: SMS alerts use dedicated `sendStaffAlertSms`, sending direct alerts to staff phone numbers without creating customer conversation threads or leaking customer phone numbers.
5. **Approved Email Sender Identity (AIF-12)**: Emails are dispatched from verified identity `ServWave Spider Alerts <alerts@spider.servwave.com>`.

---

## 8. Verification & Testing Strategy

| Verification Scope | Automated Test Suite | Key Assertions Covered |
| :--- | :--- | :--- |
| **Server Sweeper & Dedupe** | `backend/src/__tests__/spider-server-engine.test.ts` | • Dedupe key prevents repeated alerts.<br>• Leads $> 100$ evaluated without pagination cap.<br>• Editing lead notes does not reset stage timer. |
| **Tenant Isolation & Security** | `backend/src/__tests__/spider-dispatch.test.ts` | • Cross-company lead query rejected with 404.<br>• Staff without phone marked as `SKIPPED`.<br>• Two staff recipients receive SMS without collision. |
| **Email Sender Identity** | `backend/src/__tests__/email-sender-identity.test.ts` | • Shared email helpers restored to base behavior.<br>• Spider sender identity formatted cleanly. |
| **Frontend UI & Popup** | `frontend/src/components/notifications/__tests__/SpiderNotificationPopup.test.tsx` | • Popup renders unread cards.<br>• "See more" expands messages.<br>• Mark as read updates UI counters. |

---

## 9. Summary Matrix of Requirements

| Requirement | Implementation Specification | Status |
| :--- | :--- | :--- |
| **1. Stage Keys & Units** | Canonical keys (`new-contacted`, `contacted-walkthrough-scheduled`, `walkthrough-completed-estimate`) and standardized units (`Second`, `Minute`, `Hour`, `Day`, `Week`) shared via `SpiderWatcherConfig.stage_thresholds`. | **Documented & Fully Specified** |
| **2. Dedupe Key & Window** | Deterministic key `spider:${orgId}:${leadId}:${stageKey}:${startDay}:${threshold}` enforced via unique database constraint and pre-dispatch checks. | **Documented & Fully Specified** |
| **3. Activation-Time Floor** | Effective stage entrance floored by `activated_at` timestamp ($\max(\text{stageStart}, \text{activatedAt})$) to prevent backlog alert avalanche. | **Documented & Fully Specified** |
| **4. Popup & Frame Alerts** | Database-backed event emission (`spider.alert`) persisting to `NotificationRecipient` table; delivers unread state across refresh/login without localStorage. | **Documented & Fully Specified** |
