// PURPOSE: Permission/organization guards used as route preHandlers (typed codes: see auth/permissions.ts).
// WHY: Central, testable authorization; routes never hand-roll role checks. PostgreSQL RLS still backs every check.
// DEPENDS ON: types/context.ts, utils/errors.ts.

import type { FastifyRequest } from 'fastify';
import type { PermissionCode, RoleCode } from '../auth/permissions.js';
import { AppError, forbidden } from '../utils/errors.js';

export function requireOrganization() {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.ctx.organization)
      throw new AppError(
        403,
        'NO_ORGANIZATION',
        'Your account is not linked to an active organization.',
      );
  };
}

export function requirePermission(...codes: PermissionCode[]) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.ctx.organization)
      throw new AppError(
        403,
        'NO_ORGANIZATION',
        'Your account is not linked to an active organization.',
      );
    if (!codes.every((c) => request.ctx.permissions.includes(c))) throw forbidden();
  };
}

export function requireAnyPermission(...codes: PermissionCode[]) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.ctx.organization)
      throw new AppError(
        403,
        'NO_ORGANIZATION',
        'Your account is not linked to an active organization.',
      );
    if (!codes.some((c) => request.ctx.permissions.includes(c))) throw forbidden();
  };
}

export function requireRole(...roles: RoleCode[]) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.ctx.organization)
      throw new AppError(
        403,
        'NO_ORGANIZATION',
        'Your account is not linked to an active organization.',
      );
    if (!roles.some((r) => request.ctx.roles.includes(r))) throw forbidden();
  };
}

export function requirePlatformAdmin() {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.ctx.isPlatformAdmin) throw forbidden();
  };
}

export const isAdminRole = (roles: string[]) =>
  roles.includes('ORGANIZATION_OWNER') || roles.includes('ORGANIZATION_ADMIN');
