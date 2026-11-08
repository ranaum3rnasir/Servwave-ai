import { Request } from 'express';

export function tenantWhere(req: Request): { organization_id: string } {
  return { organization_id: req.user!.organization_id };
}
