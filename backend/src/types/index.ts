import { Request } from 'express';
import type { Role } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  // SRVW-138: the BASE role; grants may come from a custom role (see effectiveRole.ts).
  role: Role;
  custom_role_id?: string | null;
  custom_role?: { key: string } | null;
  is_active: boolean;
  organization_id: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: Record<string, string[]>;
}

// Re-export Prisma types
export type { Role } from '@prisma/client';
