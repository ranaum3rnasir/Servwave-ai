# Customer & ServiceLocation Test Data Rules

## 1. Customer Field Requirements

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| first_name | string | Yes | 1-100 chars, realistic name |
| last_name | string | Yes | 1-100 chars, realistic name |
| email | string | Yes | Valid email format, unique across customers |
| phone | string | Yes | 10 digits, no formatting (e.g., "5551234567") |
| phone_ext | string | No | 1-10 digits. Only present for office phones (commercial personas) |
| secondary_phone | string | No | 10 digits if present |
| secondary_phone_ext | string | No | Only if secondary_phone present |
| company_name | string | No | If present, customer is commercial. See personas for when to include |
| ad_source | string | No | Marketing attribution. Use realistic values: "Google", "Yelp", "Referral", "BBB", "Nextdoor" etc. |
| allow_billing | boolean | Default false | True only for commercial customers with payment terms |
| tax_exempt | boolean | Default false | Rare (~5%), typically government/nonprofit. Never for residential |
| payment_type | string | No | Only meaningful if allow_billing=true. Values: "COD", "NET 15", "NET 30", "NET 60", "EOM" |
| extra_emails | array | Default [] | Additional contact emails. Only for property management companies (1-2 extra) |

## 2. ServiceLocation Field Requirements

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| address_line1 | string | Yes | Street address, realistic (e.g., "4521 Cedar Ridge Dr") |
| address_line2 | string | No | Apt/Suite/Unit number |
| city | string | Yes | Real city name |
| state | string | Yes | 2-letter state code (e.g., "TX", "CA") |
| zip | string | Yes | 5-digit ZIP code |
| is_primary | boolean | Default false | Exactly one location per customer MUST be primary |

Rules:
- Every customer must have at least 1 service location
- Exactly 1 location must have `is_primary: true`
- Number of locations follows persona (residential=1, landlord=2-4, property mgmt=5-10)
- Addresses should be varied — don't reuse the same street for every test

## 3. Valid Data Rules by Persona

**Residential Homeowner:**
```
{ first_name: "Sarah", last_name: "Chen", email: "sarah.chen@gmail.com",
  phone: "5129876543", company_name: null, allow_billing: false,
  tax_exempt: false, payment_type: null, extra_emails: [] }
+ 1 ServiceLocation (their home)
```

**Commercial Property Manager:**
```
{ first_name: "Michael", last_name: "Wilson", email: "mwilson@westfieldpm.com",
  phone: "5128765432", phone_ext: "204", secondary_phone: "5127654321",
  company_name: "Westfield Property Management", allow_billing: true,
  tax_exempt: false, payment_type: "NET 30", extra_emails: ["billing@westfieldpm.com"] }
+ 3-5 ServiceLocations
```

**Small Business Owner:**
```
{ first_name: "Tony", last_name: "Marchetti", email: "tony@tonyspizzeria.com",
  phone: "5126543210", company_name: "Tony's Pizzeria", allow_billing: false,
  tax_exempt: false, payment_type: null, extra_emails: [] }
+ 1-2 ServiceLocations
```

**Landlord:**
```
{ first_name: "Robert", last_name: "Kim", email: "rkim77@yahoo.com",
  phone: "5125432109", company_name: null, allow_billing: false,
  tax_exempt: false, payment_type: null, extra_emails: [] }
+ 2-4 ServiceLocations (rental properties)
```

**Property Management Company:**
```
{ first_name: "Diana", last_name: "Reeves", email: "dreeves@apexpropertygroup.com",
  phone: "5124321098", phone_ext: "101", secondary_phone: "5123210987",
  company_name: "Apex Property Group", allow_billing: true,
  tax_exempt: false, payment_type: "NET 30",
  extra_emails: ["billing@apexpropertygroup.com", "maintenance@apexpropertygroup.com"] }
+ 5-10 ServiceLocations
```

## 4. Invalid Data for Testing

| # | Violation | Test Data | Expected Result |
|---|-----------|-----------|-----------------|
| C-01 | Missing required fields | `{ first_name: "John" }` (no last_name, email, phone) | 400 validation error |
| C-02 | Invalid email format | `{ ..., email: "not-an-email" }` | 400 validation error |
| C-03 | Invalid phone (too short) | `{ ..., phone: "123" }` | 400 validation error |
| C-04 | Duplicate email | Same email as existing customer | 400/409 uniqueness error |
| C-05 | allow_billing=true without payment_type | `{ ..., allow_billing: true, payment_type: null }` | Should warn or fail |
| C-06 | payment_type set without allow_billing | `{ ..., payment_type: "NET 30", allow_billing: false }` | Inconsistent state |
| C-07 | tax_exempt for residential | `{ ..., company_name: null, tax_exempt: true }` | Unusual but valid edge case |
| C-08 | No primary location | All locations with `is_primary: false` | Should fail or auto-set |
| C-09 | Multiple primary locations | Two locations with `is_primary: true` | Should fail constraint |
| C-10 | phone_ext without phone | `{ ..., phone: null, phone_ext: "204" }` | Invalid combination |
| C-11 | secondary_phone_ext without secondary_phone | Missing parent field | Invalid combination |
| C-12 | extra_emails with invalid format | `{ ..., extra_emails: ["not-email"] }` | Validation error |
