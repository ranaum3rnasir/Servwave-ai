# Dashboard Widgets Research — ALPHA CRM
## Date: 2026-04-02

### Research Sources
- ServiceTitan blog/playbook (daily huddle, HVAC dashboards, tech scorecards)
- Getfieldy (2026 FSM KPIs guide)
- BuildOps (40+ FSM metrics)
- FieldPulse (job costing)
- ServiceM8 (gross profit margin dashboard)
- NetSuite (field service KPIs)
- Workiz competitor screenshots (user-provided)
- Aberdeen Group 2024 study (20% higher CSAT for KPI trackers)

---

## 1. Additional Metrics/Widgets Beyond Workiz

### A. Pipeline Revenue Funnel (UNIQUE — no competitor does this well)
**Data:** Lead -> Estimate -> Approved -> Deposit Paid -> Job Scheduled -> Job Completed -> Invoiced -> Paid
**Schema sources:** Lead.status, Estimate.status + total_amount, Deposit.status, Job.status, Invoice.status + amount_due, Payment.amount
**Why actionable:** Shows exactly WHERE revenue is leaking. If 50 estimates are approved but only 20 have deposits paid, the bottleneck is clear. Workiz shows jobs-by-status but never the full revenue flow with dollar amounts at each stage.

### B. Gross Profit Margin Widget
**Data:** EstimateLineItem.unit_price vs EstimateLineItem.unit_cost, aggregated per job
**Schema sources:** EstimateLineItem.unit_cost, EstimateLineItem.unit_price, EstimateLineItem.quantity, Job (via Estimate)
**Why actionable:** Most FSM tools (Workiz, Housecall Pro) don't show margin per job on the dashboard. ServiceTitan does but at enterprise pricing. We have unit_cost on line items — use it.
**Display:** Overall margin % this month, trend line, worst-margin jobs flagged

### C. Days Sales Outstanding (DSO) Gauge
**Data:** Invoice.sent_at -> Payment.paid_at, weighted by amount
**Schema sources:** Invoice (sent_at, total_amount, status), Payment (paid_at, amount)
**Why actionable:** Cash flow is the #1 killer of SMB contractors. DSO tells them "on average, it takes X days to get paid." Industry benchmark is 30-45 days for contractors. Aberdeen research: companies tracking DSO achieve 15% better cash conversion.
**Display:** Current DSO number, 30-day trend, bucket breakdown (0-30, 31-60, 61-90, 90+)

### D. Aging Receivables Breakdown
**Data:** Outstanding invoices bucketed by days past due
**Schema sources:** Invoice (status in [SENT, PARTIAL], due_date, amount_due)
**Display:** Stacked bar or horizontal bars: Current, 1-30, 31-60, 61-90, 90+ days with dollar amounts

### E. Revenue by Job Type / Service Category
**Data:** Lead.job_type -> Estimate.line_items -> Invoice.total_amount
**Schema sources:** Lead.job_type, EstimateLineItem.price_book_item -> PriceBookItem.type/category, Invoice totals
**Why actionable:** Tells contractor which service lines are most profitable. Workiz has "Top Job Types" but only by count — not by revenue/margin.
**Display:** Donut chart (revenue by job_type), sortable table with count + revenue + avg margin

### F. Lead Source ROI
**Data:** Customer.ad_source / Lead.job_source -> revenue generated from those leads
**Schema sources:** Lead.job_source, Customer.ad_source, chain through Estimate -> Job -> Invoice -> Payment
**Why actionable:** Goes beyond Workiz's "Lead Sources donut" (which only shows lead count). We show: leads, conversion rate, AND total revenue per source. This answers "is my Google Ads spend actually generating profit?"
**Display:** Table: Source | Leads | Won | Conversion % | Revenue | Avg Job Value

### G. Estimate Win Rate Trend
**Data:** Monthly ratio of (APPROVED) / (APPROVED + DECLINED + EXPIRED + CANCELLED)
**Schema sources:** Estimate.status, Estimate.approved_at / declined_at / expired_at
**Why actionable:** Trending down = pricing problem or competitive pressure. Industry benchmark: 40-60% for residential HVAC.
**Display:** Line chart (12 months), current month highlighted

### H. Collection Rate Widget
**Data:** (Payments collected this month) / (Invoices sent this month total_amount)
**Schema sources:** Payment.paid_at, Payment.amount, Invoice.sent_at, Invoice.total_amount
**Display:** Percentage gauge with trend

---

## 2. Tech Scoreboard Metrics

### Must-Have (derivable from our schema)
1. **Revenue Generated** — SUM(Invoice.total_amount) for completed jobs assigned to tech
   - Source: Job.assigned_to -> Invoice.total_amount WHERE Job.status = COMPLETED
2. **Jobs Completed** — COUNT(Job) WHERE status = COMPLETED AND assigned_to = tech
   - Source: Job.assigned_to, Job.status, Job.completed_at
3. **Avg Completion Time** — AVG(Job.completed_at - Job.started_at)
   - Source: Job.started_at, Job.completed_at
   - Industry insight: ServiceTitan calls this "Mean Time to Repair" — critical for scheduling accuracy
4. **On-Time Rate** — % of jobs completed within scheduled window
   - Source: Job.completed_at <= Job.scheduled_end
   - Industry benchmark: 90%+ is excellent
5. **Jobs Per Day/Week** — Throughput metric
   - Source: Job.completed_at grouped by day, filtered by assigned_to
6. **Avg Job Value** — Revenue / Jobs Completed
   - Derived from metrics 1 and 2

### Nice-to-Have (would need schema additions)
- First-Time Fix Rate (would need a "callback" or "revisit" flag on jobs)
- Customer Satisfaction (would need a rating/survey model)
- Utilization Rate (would need clock-in/clock-out or availability hours)

### Research Consensus
ServiceTitan, Getfieldy, and FieldConnect all agree: Revenue + Job Count alone is insufficient. The top-performing FSM dashboards include completion time and on-time metrics because they directly impact scheduling capacity and customer satisfaction. IBM data shows FTFR industry average is 80% — but we'd need to add a revisit tracking mechanism to support this.

---

## 3. Pipeline Visualization Recommendation

### Both — but in different forms

**A. Revenue Funnel (Primary)**
Lead (count + $) -> Estimate Sent ($) -> Approved ($) -> Deposit Collected ($) -> Job Completed ($) -> Invoiced ($) -> Paid ($)
- Horizontal funnel chart showing dollar value drop-off at each stage
- Conversion % between each stage
- Time period selectable (this month, this quarter, YTD)

**B. Status Breakdown Cards (Secondary)**
- Leads by status (horizontal stacked bar, count)
- Estimates by status (horizontal stacked bar, count + value)
- Jobs by status (horizontal stacked bar, count)
- Invoices by status (horizontal stacked bar, count + value)

**Why both:** The funnel answers "how healthy is my business pipeline?" The status breakdown answers "what needs my attention right now?" Different cognitive needs.

---

## 4. "Today" Morning Check-In Summary

### Current: Today's Jobs (count only)

### Recommended "Morning Huddle" Widget (inspired by ServiceTitan Daily Huddle)

| Metric | Data Source | Why |
|--------|-----------|-----|
| Today's Scheduled Jobs | Job WHERE scheduled_start is today | Crew planning |
| Unassigned Jobs | Job WHERE status = UNASSIGNED | Dispatch urgency |
| Jobs In Progress | Job WHERE status = IN_PROGRESS | Live monitoring |
| Estimates Expiring Soon | Estimate WHERE valid_until in next 3 days AND status = SENT | Revenue at risk |
| Invoices Due Today | Invoice WHERE due_date = today AND status in [SENT, PARTIAL] | Cash flow |
| Overdue Invoices | Invoice WHERE due_date < today AND status in [SENT, PARTIAL] | Collections needed |
| Deposits Awaiting Collection | Deposit WHERE status = REQUESTED | Revenue blocked |
| Walkthroughs Scheduled Today | Lead WHERE walkthrough_scheduled_at is today | Sales calendar |
| Yesterday's Revenue | Payment WHERE paid_at = yesterday | Performance check |
| Week-to-Date Revenue vs Last Week | Payment sums compared | Trend awareness |

### Display Format
Two-column card: left = "Action Required" items (red/amber counts), right = "Today's Numbers" (neutral stats). This is better than Workiz's single "Today" card because it separates urgent from informational.

---

## 5. Hidden Insights Unique to Our Data Model

### A. Estimate Approval Velocity
**Calculation:** AVG(Estimate.approved_at - Estimate.sent_at) in days
**Why hidden:** No FSM tool surfaces this. If it takes 14 days average to get approval but only 3 days last quarter, something changed (pricing? competition? economy?).
**Schema:** Estimate.sent_at, Estimate.approved_at

### B. Deposit-to-Job Conversion Time
**Calculation:** AVG(Job.created_at - Deposit.paid_at) in days
**Why hidden:** Measures how quickly the team mobilizes after getting paid. Long gap = scheduling bottleneck or capacity issue.
**Schema:** Deposit.paid_at, Job.created_at (linked via Estimate -> Job)

### C. Lead Aging by Stage
**Calculation:** AVG time spent in each LeadStatus before moving to next
**Why hidden:** Shows where the sales process stalls. "Leads sit in CONTACTED for 8 days on average" = follow-up problem.
**Schema:** Lead.created_at, Lead.contacted_at, Lead.walkthrough_scheduled_at, Lead.walkthrough_completed_at, Estimate.created_at

### D. Payment Method Distribution
**Calculation:** Revenue breakdown by PaymentMethod (CARD, CASH, CHECK, BANK_TRANSFER)
**Why hidden:** Workiz can't do this. Card payments have processing fees (2.5-3.5%). If 60% of revenue is card, the contractor loses $15k-$21k per $1M in fees. Shifting even 10% to bank transfer saves thousands.
**Schema:** Payment.method, Payment.amount

### E. Deposit Surcharge Revenue
**Calculation:** SUM(Deposit.surcharge_amount) — pure profit from card processing surcharges
**Why hidden:** Most contractors don't track this. We have the field. It's free money visibility.
**Schema:** Deposit.surcharge_amount WHERE status = PAID

### F. Estimate-to-Invoice Leakage
**Calculation:** (Estimate.total_amount for approved estimates) vs (Invoice.total_amount for resulting jobs)
**Why hidden:** Shows scope creep or undercharging. If estimates average $5,000 but invoices average $4,200, techs are leaving money on the table.
**Schema:** Estimate.total_amount (WHERE status=APPROVED) -> Job -> Invoice.total_amount

### G. Seasonal Demand Patterns
**Calculation:** Lead/Job volume by month, overlaid with revenue
**Why hidden:** Most SMB contractors "feel" seasonal patterns but don't see them quantified. Helps with hiring decisions, marketing budget timing.
**Schema:** Lead.created_at, Job.scheduled_start grouped by month

### H. Repeat Customer Rate
**Calculation:** Customers with >1 completed job / Total customers with completed jobs
**Why hidden:** Retention metric. High repeat rate = quality service. Low = acquisition cost problem.
**Schema:** Customer -> Job (count WHERE status=COMPLETED, grouped by customer_id)

### I. Sales Rep Performance (beyond Workiz)
**Calculation:** Per assigned_to: lead count, win rate, avg estimate value, revenue generated, avg time to close
**Why hidden:** Workiz shows a basic dispatch scoreboard. We can show the full sales funnel per rep.
**Schema:** Lead.assigned_to -> Estimate (created_by or lead.assigned_to) -> approval rate -> Job -> Invoice -> Payment

### J. Urgent vs Standard Job Economics
**Calculation:** Avg revenue per urgent job vs standard job, margin comparison
**Why hidden:** Urgent jobs often have higher margins (emergency pricing). Quantifying this helps justify the urgent job workflow.
**Schema:** Job.is_urgent, Job -> Invoice.total_amount, EstimateLineItem.unit_cost (for standard jobs)
