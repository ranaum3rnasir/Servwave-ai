// The staff roster the inventory screens pick people from. In production it comes from the server, which puts
// each person in the Field roster or at the Counter by their Inventory view switch (Roles & Permissions S07.23);
// a screen never reads a role name.

export type Tech = {
  id: string;
  name: string;
  /** Real inbox from the user directory (server-resolved) — used by the pickup-ticket composer. */
  email?: string;
  /** The person's Inventory view switch, as the server answers it: Field is the field roster, Counter is the rest. */
  inventoryView: "field" | "counter";
  branch: string;
  vehicle?: string;
  primaryTrade?: "locksmith" | "door" | "security" | "hvac" | "plumbing";
  certs?: string[];
};

/** Human-readable label for each inventory view. Lifted from the prototype's
 *  PhonePage (module-local const) so the data seam owns it; consumed by the
 *  Communication directory/conference pickers and the Call Masking view. */
export const INVENTORY_VIEW_LABEL: Record<Tech["inventoryView"], string> = {
  field: "Field technician",
  counter: "Counter",
};

/** The field roster: the people whose Inventory view is Field (van owners, stage pickers). */
export function inFieldRoster(tech: Tech): boolean {
  return tech.inventoryView === "field";
}

export const techs: Tech[] = [
  {
    id: "tech_mike",
    name: "Mike Alvarez",
    inventoryView: "field",
    branch: "Brooklyn HQ",
    vehicle: "Ford Transit · BX-4421",
    primaryTrade: "locksmith",
    certs: ["NASTF VSP", "AAADM"],
  },
  {
    id: "tech_jose",
    name: "Jose Ramirez",
    inventoryView: "field",
    branch: "Brooklyn HQ",
    vehicle: "Ford Transit · BX-5108",
    primaryTrade: "hvac",
    certs: ["EPA 608", "NATE"],
  },
  {
    id: "tech_carlos",
    name: "Carlos Tran",
    inventoryView: "field",
    branch: "Queens Branch",
    vehicle: "Mercedes Sprinter · QN-9920",
    primaryTrade: "security",
    certs: ["UL 294", "BICSI"],
  },
  {
    id: "tech_stephanie",
    name: "Stephanie Diaz",
    inventoryView: "counter",
    branch: "Brooklyn HQ",
    certs: [],
  },
  {
    id: "tech_dre",
    name: "Dre Patel",
    inventoryView: "field",
    branch: "Brooklyn HQ",
    vehicle: "Ford Transit · BX-7733",
    primaryTrade: "plumbing",
    certs: ["ASSE Backflow"],
  },
  {
    id: "tech_kim",
    name: "Kim Nguyen",
    inventoryView: "counter",
    branch: "Brooklyn HQ",
    certs: [],
  },
  {
    id: "tech_alex",
    name: "Alex Romero",
    inventoryView: "field",
    branch: "Brooklyn HQ",
    vehicle: "Personal (1099)",
    primaryTrade: "door",
    certs: ["IDEA"],
  },
];
