// Field technicians + driver/dispatcher roster. In production these come
// from app_user filtered by `field_technician` role (PRD §11.7 RBAC).

export type Tech = {
  id: string;
  name: string;
  /** Real inbox from the user directory (server-resolved) — used by the pickup-ticket composer. */
  email?: string;
  role: "field_tech" | "warehouse_lead" | "counter" | "subcontractor";
  branch: string;
  vehicle?: string;
  primaryTrade?: "locksmith" | "door" | "security" | "hvac" | "plumbing";
  certs?: string[];
};

/** Human-readable label for each tech role. Lifted from the prototype's
 *  PhonePage (module-local const) so the data seam owns it; consumed by the
 *  Communication directory/conference pickers and the Call Masking view. */
export const TECH_ROLE_LABEL: Record<Tech["role"], string> = {
  field_tech: "Field technician",
  warehouse_lead: "Warehouse lead",
  counter: "Counter",
  subcontractor: "Subcontractor",
};

export const techs: Tech[] = [
  {
    id: "tech_mike",
    name: "Mike Alvarez",
    role: "field_tech",
    branch: "Brooklyn HQ",
    vehicle: "Ford Transit · BX-4421",
    primaryTrade: "locksmith",
    certs: ["NASTF VSP", "AAADM"],
  },
  {
    id: "tech_jose",
    name: "Jose Ramirez",
    role: "field_tech",
    branch: "Brooklyn HQ",
    vehicle: "Ford Transit · BX-5108",
    primaryTrade: "hvac",
    certs: ["EPA 608", "NATE"],
  },
  {
    id: "tech_carlos",
    name: "Carlos Tran",
    role: "field_tech",
    branch: "Queens Branch",
    vehicle: "Mercedes Sprinter · QN-9920",
    primaryTrade: "security",
    certs: ["UL 294", "BICSI"],
  },
  {
    id: "tech_stephanie",
    name: "Stephanie Diaz",
    role: "counter",
    branch: "Brooklyn HQ",
    certs: [],
  },
  {
    id: "tech_dre",
    name: "Dre Patel",
    role: "field_tech",
    branch: "Brooklyn HQ",
    vehicle: "Ford Transit · BX-7733",
    primaryTrade: "plumbing",
    certs: ["ASSE Backflow"],
  },
  {
    id: "tech_kim",
    name: "Kim Nguyen",
    role: "warehouse_lead",
    branch: "Brooklyn HQ",
    certs: [],
  },
  {
    id: "tech_alex",
    name: "Alex Romero",
    role: "subcontractor",
    branch: "Brooklyn HQ",
    vehicle: "Personal (1099)",
    primaryTrade: "door",
    certs: ["IDEA"],
  },
];
