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
    assertActive(request);
  };
}

/** Organizations still waiting for e-mail verification or platform approval cannot use the organization API yet. */
function assertActive(request: FastifyRequest): void {
  const status = request.ctx.organization?.status;
  if (status && status !== 'active')
    throw new AppError(
      403,
      'ORGANIZATION_NOT_ACTIVE',
      status === 'pending_approval' || status === 'pending_email'
        ? 'Your organization is waiting for approval. You can use it as soon as it is approved.'
        : 'Your organization is not active. Contact the platform team.',
    );
}

export function requirePermission(...codes: PermissionCode[]) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.ctx.organization)
      throw new AppError(
        403,
        'NO_ORGANIZATION',
        'Your account is not linked to an active organization.',
      );
    assertActive(request);
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
    assertActive(request);
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
    assertActive(request);
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
