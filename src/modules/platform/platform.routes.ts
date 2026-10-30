// PURPOSE: Platform staff endpoints: list organizations (e.g. the ones waiting for approval) and approve one.
// WHY: New organizations wait for approval after e-mail verification (migration 043); only platform admins
//      (profiles.is_platform_super_admin) may approve. These run as the system because they span organizations.
// DEPENDS ON: db/context.ts (withSystem), middleware/authorization.ts (requirePlatformAdmin), migration 043.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withSystem } from '../../db/context.js';
import { requireFeature } from '../../db/features.js';
import { requirePlatformAdmin } from '../../middleware/authorization.js';
import { AppError } from '../../utils/errors.js';
import { ok } from '../../utils/response.js';
import { API, type Deps } from '../deps.js';

const STATUSES = ['pending_email', 'pending_approval', 'active', 'suspended', 'closed'] as const;
const listQuery = z.object({ status: z.enum(STATUSES).optional() });
const idParams = z.object({ id: z.uuid() });

export function registerPlatformRoutes(app: FastifyInstance, d: Deps): void {
  const guard = { preHandler: [d.authenticate, requirePlatformAdmin()] };

  app.get(`${API}/platform/organizations`, guard, async (req) => {
    const q = listQuery.parse(req.query);
    const items = await withSystem(
      d.pool,
      async (db) =>
        (
          await db.query(
            `select o.id, o.org_code as "orgCode", o.name, o.institution_type as "institutionType", o.status,
                  o.city, o.state, o.contact_email as "contactEmail", o.contact_phone as "contactPhone",
                  p.full_name as "ownerName", o.created_at as "createdAt", o.approved_at as "approvedAt"
           from public.organizations o
           left join public.profiles p on p.id = o.created_by
           where o.deleted_at is null and ($1::text is null or o.status = $1)
           order by o.created_at desc
           limit 200`,
            [q.status ?? null],
          )
        ).rows,
    );
    return ok({ items }, req.id);
  });

  app.post(`${API}/platform/organizations/:id/approve`, guard, async (req) => {
    const { id } = idParams.parse(req.params);
    requireFeature('approval');
    const approved = await withSystem(d.pool, async (db) => {
      const done = (
        await db.query('select app.approve_organization($1, $2) as done', [id, req.ctx.userId])
      ).rows[0].done as boolean;
      if (done)
        await db.query(
          `insert into public.audit_logs (organization_id, user_id, action, resource, resource_id, ip, request_id)
           values ($1, $2, 'ORGANIZATION_APPROVED', 'organizations', $1, $3, $4)`,
          [id, req.ctx.userId, req.ip, req.id],
        );
      return done;
    });
    if (!approved)
      throw new AppError(
        409,
        'NOT_WAITING_FOR_APPROVAL',
        'This organization is not waiting for approval (it may already be active).',
      );
    return ok({ id, status: 'active' }, req.id);
  });
}
