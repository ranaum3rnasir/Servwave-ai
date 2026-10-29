# Test Data Personas

Named, consistent characters for test data. Use these personas across all test files for coherent, realistic narratives. Each persona has a backstory that determines their behavior patterns.

---

## 1. Staff Roster

The company is **Summit Mechanical Services** — a mid-size HVAC/plumbing/electrical contractor in Austin, TX with 12 technicians, 2 sales reps, 1 dispatcher, and 1 owner/admin.

### Admin

| Field | Value |
|-------|-------|
| **Name** | Marcus Rivera |
| **Email** | marcus@summitmech.com |
| **Role** | ADMIN |
| **Backstory** | Owner/operator. 20 years in the trades before starting Summit. Reviews all estimates over $5K, handles deposit refunds, voids invoices. The final decision-maker. |
| **Test ID** | `00000000-0000-0000-0000-000000000001` |

### Dispatcher

| Field | Value |
|-------|-------|
| **Name** | Amanda Foster |
| **Email** | amanda@summitmech.com |
| **Role** | DISPATCHER |
| **Backstory** | Former office manager. Schedules all jobs, manages the calendar, coordinates urgent calls. Marks deposits received when checks arrive. First to handle incoming leads when sales is busy. |
| **Test ID** | `00000000-0000-0000-0000-000000000002` |

### Sales

| Field | Value |
|-------|-------|
| **Name** | Jennifer Park |
| **Email** | jennifer@summitmech.com |
| **Role** | SALES |
| **Backstory** | Engineering background. Handles most residential and light commercial estimates. Schedules walkthroughs, writes detailed scope notes. Manages her own pipeline of 15-25 active leads. |
| **Test ID** | `00000000-0000-0000-0000-000000000003` |

| Field | Value |
|-------|-------|
| **Name** | David Okonkwo |
| **Email** | david@summitmech.com |
| **Role** | SALES |
| **Backstory** | Specializes in large commercial accounts and property management companies. Longer sales cycles, bigger deals. Has relationships with several property management firms. |
| **Test ID** | `00000000-0000-0000-0000-000000000010` |

### Technicians

| Name | Email | Specialty | Backstory | Test ID |
|------|-------|-----------|-----------|---------|
| **Carlos Mendez** | carlos@summitmech.com | HVAC | 12 years experience. Lead tech for complex installs. Thorough completion notes. Preferred for walkthroughs on AC systems. | `00000000-0000-0000-0000-000000000004` |
| **Tyler Brooks** | tyler@summitmech.com | Plumbing | 8 years experience. Go-to for emergency/urgent calls. Fast responder. Handles most after-hours urgent jobs. | `00000000-0000-0000-0000-000000000005` |
| **Raj Patel** | raj@summitmech.com | Electrical | 10 years experience. Licensed master electrician. Handles panel upgrades, commercial rewiring. Detailed walkthrough notes. | `00000000-0000-0000-0000-000000000006` |
| **Lisa Tran** | lisa@summitmech.com | HVAC | 5 years experience. Handles routine maintenance and smaller residential repairs. Reliable scheduler, rarely late. | `00000000-0000-0000-0000-000000000007` |
| **Jake Morrison** | jake@summitmech.com | Plumbing | 3 years experience. Junior tech. Paired with Tyler on complex jobs. Handles simple drain calls solo. | `00000000-0000-0000-0000-000000000008` |
| **Priya Sharma** | priya@summitmech.com | Multi-trade | 7 years experience. Cross-trained in HVAC and electrical. Handles commercial maintenance contracts. Often assigned to property management jobs. | `00000000-0000-0000-0000-000000000009` |

### When to Use Each Staff Persona

| Scenario | Primary Actor | Supporting Actors |
|----------|--------------|-------------------|
| Standard residential workflow | Jennifer (SALES) → Carlos (TECH) | Amanda (DISPATCHER) |
| Urgent plumbing call | Amanda (DISPATCHER) → Tyler (TECH) | Marcus (ADMIN) for invoice |
| Large commercial estimate | David (SALES) → Priya (TECH) | Amanda (DISPATCHER) |
| Electrical walkthrough | Jennifer (SALES) schedules → Raj (TECH) performs | |
| Routine maintenance | Amanda (DISPATCHER) → Lisa (TECH) | |
| Multi-estimate scenario | Jennifer creates both → Carlos (TECH) | |
| Partial payment flow | Any workflow → Marcus (ADMIN) records payments | |
| Deposit refund | Any workflow → Marcus (ADMIN) processes refund | |

**Rule: Rotate staff across tests.** Don't always use Carlos for every tech job or Jennifer for every estimate. Use the right persona for the scenario.

---

## 2. Customer Personas

### Persona A: Residential Homeowner (70% of customers)

Typical single-family home, one service location, pays on completion.

| Field | Example Values |
|-------|---------------|
| **Names** | Sarah Chen, Mike Johnson, Patricia Nguyen, Robert Martinez, Emily Watson |
| **Email** | Personal (gmail, yahoo, outlook) |
| **Phone** | Mobile only, no extension |
| **Company** | null |
| **allow_billing** | false |
| **tax_exempt** | false |
| **payment_type** | null (defaults to COD) |
| **extra_emails** | [] |
| **Locations** | 1 (their home) |
| **Ad sources** | Google, Yelp, Nextdoor, Referral |

**Example:**
```
{ first_name: "Sarah", last_name: "Chen", email: "sarah.chen@gmail.com",
  phone: "5129876543", company_name: null, allow_billing: false,
  tax_exempt: false, payment_type: null }
+ ServiceLocation: { address_line1: "4521 Cedar Ridge Dr", city: "Austin", state: "TX", zip: "78749", is_primary: true }
```

**Typical workflow:** Quick turnaround. Contacted same day, walkthrough within a week, estimate approved within a few days, job done within 2 weeks. Pays COD on-site (CASH or CARD).

---

### Persona B: Small Business Owner (10% of customers)

Restaurant, shop, or office. One or two locations. Mix of payment terms.

| Field | Example Values |
|-------|---------------|
| **Names** | Tony Marchetti, Sandra Liu, Greg Papadopoulos, Keisha Brown |
| **Email** | Business domain (tony@tonyspizzeria.com) |
| **Phone** | Business line, sometimes with extension |
| **Company** | Business name |
| **allow_billing** | false (small) or true (established) |
| **tax_exempt** | false |
| **payment_type** | null or NET 15 |
| **extra_emails** | [] |
| **Locations** | 1-2 |
| **Ad sources** | Google, BBB, Referral |

**Example:**
```
{ first_name: "Tony", last_name: "Marchetti", email: "tony@tonyspizzeria.com",
  phone: "5126543210", company_name: "Tony's Pizzeria", allow_billing: false }
+ ServiceLocation: { address_line1: "8910 Burnet Rd Ste 100", city: "Austin", state: "TX", zip: "78757", is_primary: true }
```

**Typical workflow:** Needs quick response (business impact). May negotiate on price. Pays by CHECK or CARD. Urgent jobs more common (equipment failure = lost revenue).

---

### Persona C: Landlord (10% of customers)

Individual who owns 2-4 rental properties. Not a company. Manages own properties.

| Field | Example Values |
|-------|---------------|
| **Names** | Robert Kim, Nancy Harper, Alan Friedman, Deborah Okafor |
| **Email** | Personal email |
| **Phone** | Mobile |
| **Company** | null |
| **allow_billing** | false |
| **tax_exempt** | false |
| **payment_type** | null |
| **extra_emails** | [] |
| **Locations** | 2-4 (rental properties) |
| **Ad sources** | Referral, Google |

**Example:**
```
{ first_name: "Robert", last_name: "Kim", email: "rkim77@yahoo.com",
  phone: "5125432109", company_name: null }
+ Locations: [
    { address_line1: "2201 E Riverside Dr #4B", city: "Austin", state: "TX", zip: "78741", is_primary: true },
    { address_line1: "1534 Manchaca Rd", city: "Austin", state: "TX", zip: "78704" },
    { address_line1: "906 W Mary St", city: "Austin", state: "TX", zip: "78704" }
  ]
```

**Typical workflow:** Tenant calls landlord → landlord creates service request. Landlord often not on-site. Urgent calls common (burst pipes, no heat in winter). Pays by BANK_TRANSFER or CHECK.

---

### Persona D: Property Management Company (5% of customers)

Professional firm managing 50+ units. Multiple contacts, billing terms, many locations.

| Field | Example Values |
|-------|---------------|
| **Names** | Diana Reeves (Apex), Michael Wilson (Westfield), Karen Cho (Lone Star Mgmt) |
| **Email** | Corporate domain |
| **Phone** | Office line + extension |
| **Secondary phone** | Direct line or mobile |
| **Company** | Company name |
| **allow_billing** | true |
| **tax_exempt** | false |
| **payment_type** | NET 30 or NET 60 |
| **extra_emails** | ["billing@...", "maintenance@..."] |
| **Locations** | 5-10+ |
| **Ad sources** | Referral, Direct |

**Example:**
```
{ first_name: "Diana", last_name: "Reeves", email: "dreeves@apexpropertygroup.com",
  phone: "5124321098", phone_ext: "101", secondary_phone: "5123210987",
  company_name: "Apex Property Group", allow_billing: true, payment_type: "NET 30",
  extra_emails: ["billing@apexpropertygroup.com", "maintenance@apexpropertygroup.com"] }
+ 5-10 ServiceLocations across Austin metro
```

**Typical workflow:** High volume, ongoing relationship. Maintenance requests submitted through their portal/email. Longer sales cycle for new contracts. Always NET 30/60 billing. Pays by CHECK or BANK_TRANSFER. Partial payments common (multiple invoices batched).

---

### Persona E: Government / Nonprofit (< 5% of customers)

Schools, churches, municipal buildings. Tax-exempt.

| Field | Example Values |
|-------|---------------|
| **Names** | Thomas Wright (Austin ISD), Maria Santos (St. Andrew's Church) |
| **Email** | Institutional domain |
| **Phone** | Office line + extension |
| **Company** | Organization name |
| **allow_billing** | true |
| **tax_exempt** | true |
| **payment_type** | NET 30 or NET 60 |
| **extra_emails** | ["facilities@..."] |
| **Locations** | 1-5 |
| **Ad sources** | Direct, Referral |

**Example:**
```
{ first_name: "Thomas", last_name: "Wright", email: "twright@austinisd.org",
  phone: "5123456789", phone_ext: "302", company_name: "Austin ISD - Facilities",
  allow_billing: true, tax_exempt: true, payment_type: "NET 60",
  extra_emails: ["facilities@austinisd.org"] }
```

**Typical workflow:** Formal procurement. Long approval cycles for estimates. Tax-exempt → `tax_amount = 0` on all invoices. Slow payment (NET 60). Always pays by CHECK or BANK_TRANSFER.

---

## 3. Service Request Patterns

Realistic service requests by trade, for use in `lead.service_request`:

### HVAC
- "AC unit not cooling — thermostat reads 78°F but house is 86°F"
- "Furnace won't ignite, clicking sound but no flame"
- "Ductwork making loud banging noise when system cycles"
- "Annual maintenance for 2 rooftop units — last serviced March 2025"
- "New construction — need 3-ton split system for 1800 sq ft addition"
- "Condensate drain line backed up, water pooling around indoor unit"

### Plumbing
- "Tenant reports pipe burst in basement — water actively leaking"
- "Kitchen sink backed up, plunger not working, slow drain for 2 weeks"
- "Water heater leaking from bottom, 10 years old"
- "Need backflow preventer installed for irrigation system — city requires"
- "Toilet running constantly, flapper replaced but still leaking"
- "Sewer line camera inspection requested — recurring drain issues"

### Electrical
- "Kitchen circuit tripping intermittently under load"
- "Need panel upgrade from 100A to 200A for EV charger install"
- "Exterior lights flickering, possible wiring issue"
- "Install dedicated 240V outlet for commercial oven in restaurant kitchen"
- "GFCI outlets in bathroom not resetting after power surge"
- "Commercial building — emergency lighting inspection required by code"

---

## 4. Address Library

Realistic Austin, TX addresses for service locations. Vary these across tests — don't reuse the same address everywhere.

### Residential
- 4521 Cedar Ridge Dr, Austin, TX 78749
- 1207 Bluebonnet Ln, Austin, TX 78704
- 3345 Shoal Creek Blvd, Austin, TX 78757
- 9802 Crest Lago Dr, Austin, TX 78726
- 2601 Live Oak St #3, Austin, TX 78702
- 6714 Manchaca Rd, Austin, TX 78745
- 11420 Running Brush Ln, Austin, TX 78750

### Commercial
- 8910 Burnet Rd Ste 100, Austin, TX 78757
- 2400 E Cesar Chavez St, Austin, TX 78702
- 5501 N Lamar Blvd Ste 200, Austin, TX 78751
- 12100 Technology Blvd Bldg 3, Austin, TX 78727
- 3601 S Congress Ave Ste 400, Austin, TX 78704

### Multi-Unit (for landlords/PMs)
- 2201 E Riverside Dr #4B, Austin, TX 78741
- 2201 E Riverside Dr #7A, Austin, TX 78741
- 1534 Manchaca Rd, Austin, TX 78704
- 906 W Mary St, Austin, TX 78704
- 4500 E Oltorf St #112, Austin, TX 78741
- 4500 E Oltorf St #205, Austin, TX 78741
- 7700 Northcross Dr #301, Austin, TX 78757

---

## 5. Completion Notes Library

Realistic technician completion notes by trade:

### HVAC
- "Replaced evaporator coil (Trane XR15 compatible). Recharged system with 3 lbs R-410A. Tested cooling — supply/return delta now 18°F. System running normally. Recommended annual maintenance."
- "Cleaned and adjusted igniter assembly. Replaced flame sensor (cracked ceramic). Tested through 5 heat cycles — consistent ignition. CO readings normal at all vents."
- "Replaced blower motor and capacitor. Balanced airflow across all registers. System cycling normally. Noted ductwork in attic has minor separation at 2 joints — quoted separately."

### Plumbing
- "Located burst pipe at basement ceiling junction. Cut out damaged 3ft section, replaced with copper. Tested — no leaks under pressure. Cleaned standing water. Advised tenant to run dehumidifier for 48 hours."
- "Cleared kitchen drain blockage. Root intrusion found at main line junction. Removed roots with cable machine. Recommended annual root treatment. Left camera inspection report with customer."
- "Replaced 40-gallon electric water heater with 50-gallon Rheem Performance Plus. Installed new expansion tank and updated supply lines. Tested hot water at all fixtures."

### Electrical
- "Diagnosed intermittent tripping on 20A kitchen circuit. Found loose neutral at panel bus. Tightened all connections, tested under load for 30 min. No further trips."
- "Upgraded main panel from 100A to 200A Square D Homeline. Installed new 50A breaker for EV charger circuit. Pulled permit #2026-EL-4521. Inspector signed off."
- "Replaced 4 non-functioning GFCI outlets in bathrooms and kitchen. Tested all circuits with plug tester. All reading correct wiring and proper ground fault protection."
