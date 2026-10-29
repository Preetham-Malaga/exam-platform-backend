// PURPOSE: Authenticates the Bearer token and builds request.ctx from the database (membership -> roles -> permissions).
// WHY: The frontend can claim anything; only verified token + database membership define who the caller is.
// DEPENDS ON: auth/gateway.ts, db/context.ts, types/context.ts. Used by every protected route.

import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuthGateway } from '../auth/gateway.js';
import { withSystem } from '../db/context.js';
import type { RequestContext } from '../types/context.js';
import { AppError } from '../utils/errors.js';

const CONTEXT_SQL = `
  select m.organization_id as "orgId", o.org_code as "orgCode", o.name as "orgName", o.status as "orgStatus",
         coalesce(array_agg(distinct r.code) filter (where r.code is not null), '{}') as roles,
         coalesce(array_agg(distinct pm.code) filter (where pm.code is not null), '{}') as permissions
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id and o.deleted_at is null
  left join public.user_roles ur on ur.organization_id = m.organization_id and ur.user_id = m.user_id
  left join public.roles r on r.id = ur.role_id
  left join public.role_permissions rp on rp.role_id = ur.role_id
  left join public.permissions pm on pm.id = rp.permission_id
  where m.user_id = $1 and m.status = 'active' and o.status in ('pending_email', 'pending_approval', 'active')
  group by m.organization_id, o.org_code, o.name, o.status, m.created_at
  order by m.created_at limit 1`;

export async function resolveContext(
  pool: Pool,
  gateway: AuthGateway,
  token: string,
): Promise<RequestContext> {
  const user = await gateway.verifyToken(token);
  if (!user)
    throw new AppError(401, 'UNAUTHENTICATED', 'Your session has expired. Please sign in again.');

  return withSystem(pool, async (db) => {
    const profile = (
      await db.query(
        'select full_name, is_platform_super_admin from public.profiles where id = $1',
        [user.id],
      )
    ).rows[0] as { full_name: string; is_platform_super_admin: boolean } | undefined;
    const org = (await db.query(CONTEXT_SQL, [user.id])).rows[0] as
      | {
          orgId: string;
          orgCode: string;
          orgName: string;
          orgStatus: string;
          roles: string[];
          permissions: string[];
        }
      | undefined;

    // E-mail confirmed: the organization now waits for a platform admin to approve it (migration 043).
    if (org && org.orgStatus === 'pending_email' && user.emailConfirmed) {
      await db.query('select app.organization_email_confirmed($1)', [org.orgId]);
      org.orgStatus = 'pending_approval';
    }
    return {
      userId: user.id,
      email: user.email,
      fullName: profile?.full_name ?? '',
      isPlatformAdmin: profile?.is_platform_super_admin ?? false,
      organization: org
        ? { id: org.orgId, code: org.orgCode, name: org.orgName, status: org.orgStatus }
        : null,
      roles: org?.roles ?? [],
      permissions: org?.permissions ?? [],
    };
  });
}

/** preHandler: requires a valid session. */
export function authenticate(pool: Pool, gateway: AuthGateway) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
    request.ctx = await resolveContext(pool, gateway, token);
  };
}
