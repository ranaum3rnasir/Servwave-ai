# ALPHA CRM Dashboard Research Report

> Product research for Step 9: Dashboard & Reports
> Date: 2026-04-02
> Audience: ALPHA CRM — FSM CRM for SMB contractors (HVAC, plumbing, electrical, 5-30 techs)

---

## 1. Manager's Daily Questions

These are the questions a contractor business owner or office manager needs answered **at a glance** every morning. Sourced from trade forums, industry blogs, and FSM vendor playbooks.

### The Morning Checklist (in priority order)

| # | Question | Why It Matters |
|---|----------|---------------|
| 1 | **What's on the schedule today?** How many jobs, who's assigned, any gaps? | Every morning starts with talking to crews and reviewing the day's schedule. This is the single most urgent question. |
| 2 | **Are all techs busy? Who's idle or overbooked?** | Idle techs = lost revenue. Overbooking = missed appointments and angry customers. |
| 3 | **How much revenue did we do yesterday / this week / this month?** | Contractors check cash flow daily. "Staying on top of finances is non-negotiable." Revenue tracking by day/week/month is table stakes. |
| 4 | **How many open leads haven't been contacted?** | 78% of customers choose the first company that responds. Responding within 1 minute increases conversion by 391%. Stale leads = lost revenue. |
| 5 | **What estimates are pending / expiring?** | Unsigned estimates are money on the table. Close rate directly impacts whether marketing spend pays off. |
| 6 | **How many invoices are unpaid / overdue?** | Cash flow is king. AR aging (30/60/90 days) must be reviewed weekly at minimum. Letting invoices age past 60 days dramatically reduces collection probability. |
| 7 | **Are any jobs overdue or at risk?** | A job taking longer than expected, a missed check-in, an unscheduled delay — small issues become big ones fast. |
| 8 | **What's my estimate close rate?** | Industry benchmark: 40-50% booking rate. Low conversion = ineffective sales process or bad leads. |
| 9 | **Are we on track for our monthly revenue target?** | The #1 question for owners. A real-time revenue meter showing completed vs. target revenue drives behavior. |
| 10 | **Any deposits pending / payments received overnight?** | Stripe payments, overnight check deposits — owners want to see money movement first thing. |

### Key Insight
> The morning routine for a successful contractor is: (1) Review today's schedule, (2) Check yesterday's revenue, (3) Follow up on stale leads and unsigned estimates, (4) Chase overdue invoices. A great dashboard answers all four in under 30 seconds.

---

## 2. KPIs That Matter for FSM Businesses

### Tier 1: Must-Have Daily KPIs (Show on Dashboard)

| KPI | Description | Benchmark | ALPHA CRM Source |
|-----|-------------|-----------|-----------------|
| **Revenue Today / This Week / This Month** | Total invoiced + collected revenue | Target varies; 10-20% annual growth is stable, 25%+ is high-performing | Invoice + Payment tables |
| **Jobs Today** | Count of scheduled jobs for today | 3-5 completed jobs/tech/day for demand work; 6-8 for maintenance | Job table |
| **Technician Utilization** | % of tech time spent on billable work | Target: 70-85% | Job assignments vs. available hours |
| **Open/Uncontacted Leads** | Leads in NEW status with no activity | Should be 0 by end of day | Lead table (status = NEW, no notes) |
| **Estimate Close Rate** | Approved estimates / Total sent estimates | 40-50% booking rate benchmark | Estimate table (APPROVED / SENT) |
| **Outstanding AR** | Total unpaid invoice value | Review weekly; escalate at 60+ days | Invoice table (SENT, not PAID) |
| **Overdue Invoices** | Count + value of past-due invoices | Should decrease week over week | Invoice due_date < today |
| **Average Ticket Size** | Average revenue per completed job | $350-$600 residential service; $1,000-$1,500/tech/day target | Invoice amounts / job count |

### Tier 2: Weekly/Monthly KPIs (Show in Reports section)

| KPI | Description | Benchmark |
|-----|-------------|-----------|
| **Revenue Per Technician** | Annual revenue generated per tech | $250K-$450K/year; rule of thumb: 5x their total comp |
| **First-Time Fix Rate** | % of jobs resolved on first visit | >80% is excellent |
| **Gross Margin** | (Revenue - COGS) / Revenue | 40-60%, ideal 50-55% |
| **Lead-to-Job Conversion** | % of leads that become completed jobs | Track full funnel: Lead -> Estimate -> Job -> Invoice |
| **Average Days to Close** | Days from lead creation to job completion | Shorter = better cash flow |
| **Customer Acquisition Cost** | Marketing spend / new customers | Track by lead source |
| **Repeat Customer Rate** | % of jobs from returning customers | Higher = healthier business |
| **Jobs Completed vs. Scheduled** | Completion rate | Target: 95%+ |

### Tier 3: Strategic KPIs (Monthly/Quarterly)

- Contract/membership attach rate
- Revenue by service type (install vs. repair vs. maintenance)
- Revenue by ZIP code / service area (heat map)
- Seasonal demand trends
- Technician performance scorecards

### What Real Contractors Say They Track
- **ServiceTitan users** track: booking rate, conversion rate, average ticket, revenue per tech, memberships sold, revenue by campaign
- **Industry experts** say conversion rate is "the #1 statistic to track" as it affects advertising costs, reviews, referral rates, and general business health
- **Aberdeen Group (2024)**: Organizations tracking KPIs have 20% higher customer satisfaction and 15% higher technician productivity

---

## 3. Decision-Making from the Dashboard (Actionable Items)

The dashboard should not just display data — it should drive action. Each metric should have a clear "next step" the user can take directly.

### Quick Actions Model

| Dashboard Element | Trigger | Action Available |
|-------------------|---------|-----------------|
| **Uncontacted Leads** (count > 0) | Leads sitting in NEW status | Click -> Go to lead -> Assign / Contact |
| **Unassigned Jobs** (count > 0) | Jobs without a technician | Click -> Go to schedule -> Drag-and-drop assign |
| **Pending Estimates** (count shown) | Estimates awaiting customer response | Click -> Go to estimate -> Resend / Follow up |
| **Overdue Invoices** (aging buckets) | Invoices past due date | Click -> Go to invoice -> Send reminder / Record payment |
| **Today's Schedule** (visual) | Today's job timeline | Click job -> View details / Reassign |
| **Tech Availability** (who's free) | Techs with no current job | Click -> Assign to unassigned job |
| **Expiring Estimates** | Estimates nearing expiration | Click -> Follow up / Extend |
| **Revenue vs. Target** (gauge) | Below target pace | Visual motivator; no direct action needed |

### Key Design Principle
> "Each dashboard should give clear outcomes such as reassigning the night shift or reordering stock. Good design makes the next action obvious." — CRM dashboard best practices

### Priority: "Needs Attention" Section
A dedicated section showing items that require immediate action:
- Leads uncontacted for >24 hours
- Jobs scheduled today with no tech assigned
- Estimates expiring within 48 hours
- Invoices overdue by 30+ days
- Jobs running past expected completion

This is the **single most valuable section** of the dashboard — it tells the manager exactly what to do right now.

---

## 4. Role-Based Dashboard Needs

### Admin / Owner Dashboard
**Focus: Business health, revenue, profitability**

| Section | Content |
|---------|---------|
| Revenue Overview | Today / This Week / This Month / vs. Target (with trend) |
| KPI Strip | Total Revenue, Outstanding AR, Close Rate, Active Jobs, Open Leads |
| Revenue Chart | Line chart: daily revenue over last 30 days |
| Needs Attention | Overdue invoices, stale leads, expiring estimates |
| Team Performance | Revenue per tech, jobs completed per tech |
| Pipeline Summary | Leads by status, Estimates by status |
| Quick Links | AR aging report, Revenue report, Team scorecard |

### Dispatcher Dashboard
**Focus: Today's operations, schedule, tech availability**

| Section | Content |
|---------|---------|
| Today's Schedule | Mini calendar/timeline of all jobs today |
| Unassigned Jobs | List of jobs needing assignment (with drag-to-assign) |
| Tech Status Board | Each tech: current job, next job, availability, location |
| Needs Attention | Overdue jobs, schedule conflicts, unassigned work |
| Quick Stats | Jobs today, Jobs completed, Jobs remaining, Techs active |

### Sales Dashboard
**Focus: Lead pipeline, estimate conversion, follow-ups**

| Section | Content |
|---------|---------|
| My Leads | Open leads assigned to me, sorted by urgency |
| Pipeline Funnel | Lead -> Estimate -> Approved -> Job (counts + values) |
| Close Rate | My estimate conversion rate vs. team average |
| Follow-ups Due | Leads/estimates needing follow-up today |
| KPI Strip | My Leads (open), My Estimates (pending), My Close Rate, Revenue Generated |
| Needs Attention | Uncontacted leads, estimates expiring soon |

### Technician Dashboard
**Focus: My jobs today, my schedule**

| Section | Content |
|---------|---------|
| My Schedule Today | Ordered list of today's jobs with times, addresses, customer info |
| Current Job | Large card: job details, customer contact, notes, charges |
| Quick Stats | Jobs today, Jobs completed, Revenue generated |
| My Performance | Weekly stats: jobs completed, average ticket, customer ratings |

---

## 5. What Separates Good from Great

### Why Contractors Ignore Dashboards

1. **Too complex / too many metrics**: "A dashboard with every KPI is not providing the key indicators your team needs." Overloaded dashboards paralyze instead of inform.
2. **Takes too long to set up**: "While competitors like Salesforce can take six months to set up, most contractors are up and running with [simpler tools] in under a week." If it's not useful on Day 1, it won't get used on Day 30.
3. **Not mobile-friendly**: Contractors are in the field. If the dashboard doesn't work on a phone, it's useless for half the team.
4. **Data isn't actionable**: Showing numbers without enabling action creates frustration. "What am I supposed to DO about this?"
5. **Stale data**: If the dashboard shows yesterday's numbers, contractors stop trusting it. Real-time or near-real-time is expected.

### What Makes Contractors Actually USE Their Dashboard

1. **Glanceable in under 30 seconds**: The Z-pattern scanning principle — put critical numbers on the natural eye path. Heavy, close, high-contrast elements get read first.
2. **"Needs Attention" items front and center**: The #1 feature that drives daily use. Not metrics — action items. "You have 3 uncontacted leads, 2 overdue invoices, 1 unassigned job."
3. **One click to act**: Every flagged item should be one click away from the action screen. Overdue invoice -> click -> invoice detail -> send reminder.
4. **Role-appropriate by default**: Don't show techs the revenue dashboard. Don't show owners the tech schedule. Each role sees what they need.
5. **Real-time data**: Cloud-based sync, no manual refresh. "ServiceTitan compiles stats in real time thanks to cloud-based sync."
6. **Morning briefing mindset**: Design the dashboard as if it's the first screen the user opens with their coffee. What do they NEED to know right now?
7. **Trends, not just snapshots**: "Revenue this month: $45K" is good. "Revenue this month: $45K (up 12% vs. last month)" is great. Context makes numbers meaningful.
8. **Simple, clean UI**: "Standout dashboards are built on a minimalist UI and interactive visualizations." Familiarity reduces learning curve. Leverage existing mental models.

### The "Great Dashboard" Formula

```
GREAT = Glanceable + Role-specific + Actionable + Trending + Real-time
```

- **Glanceable**: 5-7 KPIs max on the main view. No scrolling needed for the essentials.
- **Role-specific**: Different default view per role. Admin sees revenue, dispatcher sees schedule, sales sees pipeline, tech sees their jobs.
- **Actionable**: Every metric links to the thing you'd do about it. Overdue invoices count -> click -> filtered invoice list.
- **Trending**: Show direction (up/down arrows, sparklines, vs. last period). A number without trend is just a number.
- **Real-time**: Data refreshes automatically. No "last updated 3 hours ago."

---

## 6. Competitive Landscape Summary

| Feature | ServiceTitan | Housecall Pro | Jobber | FieldPulse |
|---------|-------------|---------------|--------|------------|
| Role-based dashboards | Yes (advanced) | Basic | Basic | Moderate |
| Revenue tracking | Real-time meter | Yes | Yes | Yes |
| Tech scorecards | Yes (detailed) | Basic metrics | No | No |
| Heat map | Yes (ZIP code) | No | No | No |
| Needs attention | Yes | Limited | Limited | Limited |
| Mobile dashboard | Yes | Yes (praised) | Yes | Yes |
| Ease of use | Complex (enterprise) | Easy (most praised) | Easy | Moderate |
| Target market | $5M+ contractors | SMB (praised for simplicity) | SMB | SMB |

### ALPHA CRM Opportunity
ServiceTitan has the richest dashboard but is designed for larger contractors ($5M+ revenue) and is complex. Housecall Pro and Jobber are loved for simplicity but lack depth. **ALPHA CRM can win by combining ServiceTitan-level intelligence with Housecall Pro-level simplicity.**

---

## 7. Recommendations for ALPHA CRM Dashboard (Step 9)

### Must-Build (MVP Dashboard)

1. **"Needs Attention" card** — the single most valuable element
   - Uncontacted leads (>24h)
   - Unassigned jobs (today + tomorrow)
   - Expiring estimates (within 48h)
   - Overdue invoices (with aging: 30/60/90)
   - Each item is clickable -> navigates to detail page

2. **KPI strip** (consistent with existing page patterns)
   - Revenue: Today | This Week | This Month
   - Open Leads | Pending Estimates | Active Jobs | Overdue Invoices
   - With trend indicators (up/down vs. previous period)

3. **Today's Schedule snapshot**
   - Mini timeline showing today's jobs
   - Tech utilization visual (who's busy, who's free)
   - Count of unassigned jobs

4. **Revenue chart**
   - Line chart: daily revenue, last 30 days
   - With target line overlay if target is set

5. **Role-based default views**
   - Admin: Full dashboard (all sections)
   - Dispatcher: Schedule-focused (today's schedule + unassigned + tech status)
   - Sales: Pipeline-focused (leads + estimates + close rate)
   - Technician: My Jobs Today (simple list)

### Nice-to-Have (Post-MVP)

- Revenue vs. target gauge
- Technician performance scorecards
- Lead source ROI tracking
- Service area heat map
- Seasonal trend analysis
- Customizable widget layout (drag-and-drop)
- Email/SMS morning digest

### Design Principles for Implementation

1. Follow existing ALPHA CRM KPI strip pattern (`text-3xl` values, `divide-x`)
2. Cards with `bg-white rounded-xl p-6 shadow-card border border-border`
3. Maximum 7 KPIs visible without scrolling
4. Every number is clickable (navigates to filtered list)
5. Trend arrows on all KPIs (green up, red down, gray neutral)
6. Auto-refresh data (TanStack Query with 30-60 second stale time)
7. Responsive: works on tablet for office managers at the front desk

---

## Sources

- [ServiceTitan: 19 Key Field Service Metrics (2026)](https://www.servicetitan.com/blog/field-service-metrics)
- [ServiceTitan: KPIs at a Glance — Contractor Playbook](https://www.servicetitan.com/guides/contractor-playbook/kpis)
- [ServiceTitan: Field Service Dashboards Guide](https://www.servicetitan.com/blog/field-service-dashboard)
- [ServiceTitan: HVAC Dashboards](https://www.servicetitan.com/blog/hvac-dashboard)
- [ServiceTitan: Service KPIs for Every Role](https://www.servicetitan.com/blog/webinar-recap-service-kpis)
- [ServiceTitan: Conversion Rate — Keith Mercurio](https://www.servicetitan.com/blog/keith-mercurio-kpis)
- [Fieldy: 2026 Guide to Field Service KPIs](https://getfieldy.com/blogs/field-service-metrics-kpi-examples)
- [BuildOps: 40+ Field Service Metrics & KPIs](https://buildops.com/resources/field-service-metrics-kpis/)
- [BuildOps: Field Service Dashboards](https://buildops.com/resources/field-service-dashboards/)
- [BuildOps: Field Service Dispatching Guide](https://buildops.com/resources/field-service-dispatching-guide/)
- [BaaDigi: HVAC Business Benchmarks 2026](https://www.baadigi.com/blog/hvac-business-benchmarks-2026-revenue-profit-margins-conversion-rates)
- [Fieldproxy: 10 Essential KPIs Every HVAC Business Owner Must Track Daily](https://www.fieldproxy.ai/blog/10-essential-kpis-every-hvac-business-owner-must-track-daily-d1-36)
- [FieldPulse: HVAC Performance Metrics](https://www.fieldpulse.com/resources/blog/hvac-performance-metrics)
- [simprogroup: HVAC KPIs — 26 Metrics](https://www.simprogroup.com/blog/hvac-business-kpis-guide)
- [WebFX: 2026 HVAC Marketing Benchmarks](https://www.webfx.com/blog/home-services/hvac-marketing-benchmarks/)
- [ACCA Blog: Day in the Life of a Small HVAC Business Owner](https://hvac-blog.acca.org/day-life-small-hvac-business-owner/)
- [PinkCallers: Contractor Lead Tracking Guide](https://www.pinkcallers.com/blog/contractor-lead-tracking-complete-guide)
- [FastEasyAccounting: Week in the Life of a Profitable Contractor](https://www.fasteasyaccounting.com/blog/a-week-in-the-life-of-a-profitable-contractor-habits-that-pay-off)
- [Johnny Grow: CRM Dashboard Best Practices](https://johnnygrow.com/bi/crm-dashboard-best-practices/)
- [Johnny Grow: CRM Dashboard Design](https://johnnygrow.com/bi/crm-dashboard-design/)
- [Explo: CRM Dashboards — Key Elements and Best Practices](https://www.explo.co/blog/crm-dashboards-key-elements-best-practices)
- [DataCamp: Effective Dashboard Design](https://www.datacamp.com/tutorial/dashboard-design-tutorial)
- [Coupler.io: CRM Dashboards Best Practices](https://blog.coupler.io/crm-dashboards/)
- [FieldPulse: Housecall Pro vs Jobber Comparison](https://www.fieldpulse.com/resources/blog/housecall-pro-vs-jobber)
- [Dataforma: 12 Field Service Metrics](https://www.dataforma.com/12-field-service-metrics-you-need-to-monitor/)
- [PlotPath: 10 Essential QuickBooks Reports for Trades Businesses](https://plotpath.com/10-essential-quickbooks-reports-every-trades-business-owner-needs/)
