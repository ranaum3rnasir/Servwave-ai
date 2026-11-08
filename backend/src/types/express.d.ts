import { Role } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        first_name: string;
        last_name: string;
        // SRVW-138: the BASE role. Every branch asking "what kind of user is this"
        // reads this; only GRANT lookups go through grantRoleKey.
        role: Role;
        custom_role_id?: string | null;
        // Selected wherever custom_role_id is - grantRoleKey throws without it rather
        // than silently falling back to the base role's grant set.
        custom_role?: { key: string } | null;
        has_login?: boolean;
        organization_id: string;
        org_is_demo?: boolean;
        // Effective plan + resolved feature keys, flattened from the organization
        // relation by auth-user.ts. OPTIONAL on purpose: a cached JWT minted
        // before this shipped, or a test mock, may omit them — every consumer
        // must tolerate undefined (backend `?? []`, frontend fails open).
        org_plan?: string;
        org_features?: string[];
        department_id?: string | null;
        location_id?: string | null;
        phone?: string | null;
        phone_ext?: string | null;
      };
      ability?: import('../lib/permissions/defineAbility').AppAbility;
      // #2041 — the resolved+substituted `Customer` row-scope fragment (scopeWhereForReq(req,
      // 'Customer')), memoised ONCE per request by `attachCustomerScope` right after
      // `attachAbility` runs. Lets the customer-contact presenters (redactCustomerContactFor et
      // al) stay pure/synchronous instead of re-awaiting the grant lookup at each of dozens of
      // call sites — see backend/src/lib/permissions/customerScope.ts.
      customerScope?: Record<string, unknown>;
    }
  }
}
