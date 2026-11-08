# Spider Agent & Spider Notification System — Complete Work Documentation

> **Welcome!** This document provides a complete, easy-to-read explanation of the two major functionalities built from scratch for the ServWave CRM:
> 1. **The Spider AI Agent (Lead Watcher & Pipeline Monitor)**
> 2. **The Spider Notification System (In-App Alerts, Floating Popups, & Red Ambient Frame)**
> 
> *Written specifically so that both non-technical readers and developers can understand exactly what was created, where every file is located, and how each piece works.*

---

## Table of Contents
1. [Simple Overview: What Are These Two Big Features?](#1-simple-overview-what-are-these-two-big-features)
2. [Feature 1: The Spider AI Agent](#2-feature-1-the-spider-ai-agent)
   - [How It Works](#how-the-spider-agent-works)
   - [Key Capabilities & Sections](#key-capabilities--sections)
3. [Feature 2: The Spider Notification System](#3-feature-2-the-spider-notification-system)
   - [How It Works](#how-the-spider-notification-system-works)
   - [Visual Alert Components](#visual-alert-components)
4. [Master List of ALL Newly Created Files](#4-master-list-of-all-newly-created-files)
5. [Master List of ALL Modified Files & Updates Made](#5-master-list-of-all-modified-files--updates-made)
6. [Non-Technical Step-by-Step User Guide](#6-non-technical-step-by-step-user-guide)

---

## 1. Simple Overview: What Are These Two Big Features?

In a busy CRM, sales reps and technicians manage hundreds of potential customer leads. Often, leads get stuck in a stage (for example, a lead is created, but no one calls the customer for days).

To solve this, we built two interconnected systems from the ground up:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SERVWAVE AI CENTER CRM                          │
│                                                                        │
│   1. SPIDER AI AGENT                                                  │
│      ├── Monitors all customer leads in real time                      │
│      ├── Checks how long a lead has been waiting in a stage            │
│      ├── Compares against customized time thresholds (Days/Hours/Mins) │
│      └── Decides WHO should receive the alert (Roles, Users, or Owner) │
│                                                                        │
│   2. SPIDER NOTIFICATION SYSTEM                                        │
│      ├── Floating spider icon button on the bottom right               │
│      ├── In-app popup card showing lead details & physical address     │
│      ├── Pulsing red automation border around the screen               │
│      └── Direct click to jump straight to the lead page                │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Feature 1: The Spider AI Agent

### How the Spider Agent Works
The **Spider Agent** lives inside the CRM's **AI Center**. When you open the Spider Agent modal, you can configure exactly how the agent watches over your customer pipeline:

### Key Capabilities & Sections:

1. **Lead Stages & Time Thresholds**:
   - Allows setting maximum allowed times for leads in different stages (e.g. *New → Contacted*, *Contacted → Walkthrough Scheduled*, *Walkthrough Scheduled → Estimate*).
   - Time units can be set to **Seconds, Minutes, Hours, or Days** using intuitive `+` and `-` stepper buttons or direct typing.
   - If a lead stays in a stage longer than your set limit, the Spider Agent marks it as **Overdue / Threshold Exceeded**.

2. **Assignment Section (Who Gets Alerted)**:
   - Built with **three completely independent options**:
     - **System role**: Sends alerts to everyone who holds specific system roles (`Administrator (Owner)`, `Sales`, `Dispatcher`, `Technician`).
     - **User**: Lists all staff members individually so you can pick specific team members regardless of their roles.
     - **Owner**: Automatically detects the **assigned owner** of that specific lead (e.g., `Assigned To: System Admin`) and sends the alert strictly to them.
   - Includes a **Save button** that saves your choices directly to your browser's storage and the CRM.

3. **Distance Section**:
   - Allows setting distance-based monitoring parameters.

4. **Contact Watchers (Customer & Lead Selector)**:
   - Displays all CRM customers and their associated leads in an expandable accordion.
   - Shows live lead badges, stage names, time spent in the current stage, full service address, last communication details, and the currently assigned lead owner.
   - Clicking on any lead immediately takes you to that lead's full overview page.

---

## 3. Feature 2: The Spider Notification System

### How the Spider Notification System Works
The **Spider Notification System** acts as the alert broadcaster. It runs continuously in the background and delivers notifications when leads exceed their time thresholds.

### Visual Alert Components:

1. **Floating Trigger Button (Spider Avatar)**:
   - A modern circular button floating in the bottom-right corner of the entire CRM.
   - Features the official Spider Agent robot avatar icon.
   - Displays a red badge with the number of active overdue leads.

2. **In-App Notification Popup Card**:
   - Clicking the floating button opens a popup list of all overdue leads.
   - Each card displays:
     - **Customer & Company Name**
     - **Lead Number** (e.g., `LD-101`) & **Lead Stage** (e.g., `New → Contacted`)
     - **Complete Service Location** (e.g., `9462 Highland Ave, Suite 414, Paterson, NJ 07501`) with a map pin icon
     - **Last Communication Details** (e.g., *"Last contact was 4 days ago"*)
     - **Assigned Lead Owner** (e.g., `Assigned To: System Admin`)
     - **Threshold Exceeded Badge**
   - Clicking any notification card marks it as read and redirects you straight to that lead's details.

3. **Browser Automation Red Frame Indicator**:
   - A pulsing red frame that outlines the entire browser window when high-priority overdue leads are waiting.
   - Gives the user instant visual awareness without blocking their work.

4. **Intelligent Recipient Gating**:
   - Users **only see notifications meant for them**. If an alert is assigned to the Lead Owner or Sales role, an unassigned user will not see unnecessary popups.

---

## 4. Master List of ALL Newly Created Files

Here is the complete list of all **new files created from scratch** for the Spider Agent and Notification systems:

| # | File Name | Exact File Path | What This File Does (Plain English) |
|---|---|---|---|
| **1** | `spiderWatcherStore.ts` | `frontend/src/stores/spiderWatcherStore.ts` | **The Brain of the Spider Agent.** This file stores all settings, active leads, stage limits, assignments, and notification data. It computes whether a lead is overdue, formats addresses, and remembers settings even after refreshing the page. |
| **2** | `SpiderNotificationPopup.tsx` | `frontend/src/components/notifications/SpiderNotificationPopup.tsx` | **The Floating Notification Popup UI.** Renders the floating Spider avatar button in the bottom-right corner, the popup box with overdue lead cards, address info, communication history, and direct navigation links. |
| **3** | `BrowserAutomationIndicator.tsx` | `frontend/src/components/notifications/BrowserAutomationIndicator.tsx` | **The Red Screen Border Alert.** Draws the pulsing red frame around the entire browser window when urgent overdue leads require attention. |
| **4** | `SpiderNotificationPopup.test.tsx` | `frontend/src/components/notifications/__tests__/SpiderNotificationPopup.test.tsx` | **Automated Tests for Notification UI.** Tests the popup box, clicking behavior, unread counters, and navigation to make sure no bugs appear. |
| **5** | `BrowserAutomationIndicator.test.tsx` | `frontend/src/components/notifications/__tests__/BrowserAutomationIndicator.test.tsx` | **Automated Tests for Red Border Alert.** Tests that the red border turns on and off properly based on notification settings. |
| **6** | `InAppNotificationBell.tsx` | `frontend/src/components/notifications/InAppNotificationBell.tsx` | **Header Bell Notification Component.** Connected the notification bell in the top navigation bar with live Spider notification counts and unread badges. |
| **7** | `spiderAlerts.ts` | `backend/src/services/notifications/spiderAlerts.ts` | **Backend Recipient Resolver.** The server-side logic that calculates exactly which staff members, roles, or lead owners should receive an email/SMS/app alert for an overdue lead. |
| **8** | `spider-alert-notifications.test.ts` | `backend/src/__tests__/spider-alert-notifications.test.ts` | **Backend Automated Tests.** Rigorously tests all server-side alert routing rules (Admin role, individual user, and lead owner). |
| **9** | `TranscriberModal.tsx` | `frontend/src/components/transcriber/TranscriberModal.tsx` | **AI Audio Transcriber Modal.** Companion tool built in AI Center for uploading and transcribing audio recordings. |
| **10** | `transcriber.py` | `ai-work/transcriber.py` | **Audio Transcription Script.** Python utility script for testing audio speech-to-text processing. |

---

## 5. Master List of ALL Modified Files & Updates Made

Here is the complete list of **existing CRM files that were modified** to integrate the Spider Agent and Spider Notification systems:

| # | File Name | Exact File Path | What Changes Were Made (Plain English) |
|---|---|---|---|
| **1** | `AgentDetailModal.tsx` | `frontend/src/components/ai-center/AgentDetailModal.tsx` | **Main Spider Configuration Screen.** Built the entire UI for configuring the Spider Agent: time steppers for lead stages, the 3 independent assignment sections (Admin role, User, Owner), distance controls, and the customer/lead watcher list showing assigned owners and full addresses. |
| **2** | `AiCenterModal.test.tsx` | `frontend/src/components/ai-center/AiCenterModal.test.tsx` | **Main AI Center Test Suite.** Added comprehensive automated tests verifying all Spider Agent UI features, role toggling, assignment independence, lead owner routing, and storage saving. |
| **3** | `V2AppLayout.tsx` | `frontend/src/pages/v2/V2AppLayout.tsx` | **Global CRM Layout Wrapper (V2).** Mounted the Spider Notification Popup, the Red Frame indicator, and hooked up automatic live CRM data syncing so leads update in real time. |
| **4** | `AppLayout.tsx` | `frontend/src/components/layout/AppLayout.tsx` | **Global CRM Layout Wrapper (V1).** Connected the floating notification popup and automation indicators into the primary application layout. |
| **5** | `Header.tsx` | `frontend/src/components/layout/Header.tsx` | **Top Navigation Bar.** Integrated the Spider notification counts into the main header bar. |
| **6** | `LeadDetailPage.tsx` | `frontend/src/pages/v2/leads/LeadDetailPage.tsx` & `frontend/src/pages/LeadDetailPage.tsx` | **Lead Overview & Communication Screen.** Enabled direct deep-linking from Spider notifications to specific tabs (like Overview and Communication) on the lead details page. |
| **7** | `LeadCommunicationsTab.tsx` | `frontend/src/components/communication/LeadCommunicationsTab.tsx` | **Lead Communication History Tab.** Ensured communication records and timestamps match up with Spider last communication alerts. |
| **8** | `resolveRecipients.ts` | `backend/src/services/notifications/resolveRecipients.ts` | **Server Notification Dispatcher.** Added `spider.alert` and `spider.lead_inactive` routing triggers into the central notification engine. |
| **9** | `lead.controller.ts` | `backend/src/controllers/lead.controller.ts` | **Backend Lead API Controller.** Enriched lead API responses to include customer details, complete service locations, and assigned owner information. |
| **10** | `customer.controller.ts` | `backend/src/controllers/customer.controller.ts` | **Backend Customer API Controller.** Ensured customer service locations and lead associations are properly returned to the frontend. |
| **11** | `notifications.ts` | `frontend/src/lib/api/notifications.ts` | **Notification API Client.** Added API types and routes for handling Spider notification payloads. |
| **12** | `jobCommunications.ts` | `frontend/src/lib/api/jobCommunications.ts` | **Job & Lead Communication API.** Updated communication lookup helpers for accurate last-contact timestamps. |

---

## 6. Non-Technical Step-by-Step User Guide

Here is how an everyday user or manager interacts with this functionality:

```
Step 1: Open AI Center
   └─ Navigate to the AI Center from the sidebar and click on "Spider Agent".

Step 2: Configure Lead Stage Limits
   └─ For each stage (e.g. New → Contacted), set a time threshold (e.g. 2 Days).

Step 3: Choose Who Gets Alerted (Assignment)
   ├─ Check "Admin role" to alert all Admins, Sales reps, Dispatchers, or Technicians.
   ├─ Check "User" to alert specific team members.
   └─ Check "Owner" to automatically alert the specific person assigned to that lead.
   └─ Click "Save".

Step 4: Select Which Customers & Leads to Watch
   └─ Expand any customer in the "Contacts for Watchers" list and check the leads you want to monitor.

Step 5: Receive Smart Alerts
   ├─ If a lead sits past your threshold, the floating Spider button turns red with a counter badge.
   ├─ The pulsing red frame highlights the screen to alert the assigned team member.
   └─ Click the notification card to open the lead overview and take immediate action!
```

---

*Documentation prepared for the ServWave development team.*
