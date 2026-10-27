// PURPOSE: Organization members: list, invite admins (owner only), change role/status, plus the role/permission catalogue.
// WHY: "Users" is the account layer above teacher/student records. Role changes are guarded twice: here and by RLS.
// DEPENDS ON: _shared/invite.ts, SQL app.add_member, RLS policies on user_roles / organization_members.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withSystem, withUser } from '../../db/context.js';
import { requirePermission, requireRole } from '../../middleware/authorization.js';
import { audit } from '../../utils/audit.js';
import { AppError, fromDatabaseError, notFound } from '../../utils/errors.js';
import { likePattern, listQuerySchema, paginate } from '../../utils/pagination.js';
import { ok } from '../../utils/response.js';
import { API, type Deps } from '../deps.js';
import { ensureAuthUser } from '../_shared/invite.js';

const SORT: Record<string, string> = {
  fullName: 'p.full_name',
  email: 'p.email',
  joinedAt: 'm.joined_at',
};
const userParams = z.object({ userId: z.uuid() });

export function registerUserRoutes(app: FastifyInstance, d: Deps): void {
  app.get(
    `${API}/users`,
    { preHandler: [d.authenticate, requirePermission('user.read')] },
    async (req) => {
      const q = listQuerySchema.parse(req.query);
      const role = z
        .enum(['ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN', 'TEACHER', 'STUDENT'])
        .optional()
        .parse((req.query as Record<string, string>).role);
      const params: unknown[] = [req.ctx.organization!.id];
      const where = ['m.organization_id = $1'];
      if (q.search) {
        params.push(likePattern(q.search));
        where.push(
          `(p.full_name ilike $${params.length} or p.email::text ilike $${params.length})`,
        );
      }
      const having = role
        ? (params.push(role), `having $${params.length} = any(array_agg(r.code))`)
        : '';
      params.push(q.pageSize, (q.page - 1) * q.pageSize);
      const rows = await withUser(
        d.pool,
        req.ctx.userId,
        async (db) =>
          (
            await db.query(
              `select m.user_id as "userId", p.email, p.full_name as "fullName", m.status, m.joined_at as "joinedAt",
              coalesce(array_agg(distinct r.code) filter (where r.code is not null), '{}') as roles, count(*) over() as "__total"
       from public.organization_members m
       join public.profiles p on p.id = m.user_id
       left join public.user_roles ur on ur.organization_id = m.organization_id and ur.user_id = m.user_id
       left join public.roles r on r.id = ur.role_id
       where ${where.join(' and ')} group by m.id, p.id ${having}
       order by ${SORT[q.sort ?? 'fullName'] ?? SORT.fullName} ${q.order === 'desc' ? 'desc' : 'asc'}, m.id
       limit $${params.length - 1} offset $${params.length}`,
              params,
            )
          ).rows as Array<Record<string, unknown>>,
      );
      const total = rows.length ? Number(rows[0]!['__total']) : 0;
      return ok(
        paginate(
          rows.map(({ __total, ...r }) => r),
          total,
          q,
        ),
        req.id,
      );
    },
  );

  app.post(
    `${API}/users/admins`,
    {
      preHandler: [
        d.authenticate,
        requireRole('ORGANIZATION_OWNER'),
        requirePermission('user.create'),
      ],
    },
    async (req, reply) => {
      const body = z
        .object({
          email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
          fullName: z.string().trim().min(2).max(150),
        })
        .parse(req.body);
      const org = req.ctx.organization!.id;
      const user = await ensureAuthUser(d.pool, d.gateway, body.email, `${d.frontendUrl}/login`);
      try {
        await withSystem(d.pool, (db) =>
          db.query('select app.add_member($1,$2,$3,$4,$5,$6)', [
            org,
            user.id,
            body.email,
            body.fullName,
            'ORGANIZATION_ADMIN',
            req.ctx.userId,
          ]),
        );
      } catch (err) {
        if (user.created) await d.gateway.deleteUser(user.id).catch(() => undefined);
        throw fromDatabaseError(err) ?? err;
      }
      await audit(d.pool, req, 'USER_CREATED', 'organization_members', user.id, {
        role: 'ORGANIZATION_ADMIN',
      });
      reply.code(201);
      return ok({ userId: user.id }, req.id);
    },
  );

  app.put(
    `${API}/users/:userId/role`,
    { preHandler: [d.authenticate, requirePermission('user.update')] },
    async (req) => {
      const { userId } = userParams.parse(req.params);
      const { role } = z
        .object({ role: z.enum(['ORGANIZATION_ADMIN', 'TEACHER', 'STUDENT']) })
        .parse(req.body);
      const org = req.ctx.organization!.id;
      const isOwner = req.ctx.roles.includes('ORGANIZATION_OWNER');
      if (userId === req.ctx.userId)
        throw new AppError(400, 'BAD_REQUEST', 'You cannot change your own role.');
      await withUser(d.pool, req.ctx.userId, async (db) => {
        const current = (
          await db.query(
            `select r.code from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.organization_id = $1 and ur.user_id = $2`,
            [org, userId],
          )
        ).rows.map((r) => r.code as string);
        if (!current.length) throw notFound('User');
        if (current.includes('ORGANIZATION_OWNER'))
          throw new AppError(403, 'FORBIDDEN', 'The organization owner role cannot be changed.');
        if ((current.includes('ORGANIZATION_ADMIN') || role === 'ORGANIZATION_ADMIN') && !isOwner) {
          throw new AppError(403, 'FORBIDDEN', 'Only the organization owner can manage admins.');
        }
        await db.query(
          `delete from public.user_roles ur using public.roles r where r.id = ur.role_id and ur.organization_id = $1 and ur.user_id = $2 and r.code in ('ORGANIZATION_ADMIN','TEACHER','STUDENT')`,
          [org, userId],
        );
        await db.query(
          `insert into public.user_roles (organization_id, user_id, role_id, created_by) select $1, $2, r.id, $3 from public.roles r where r.code = $4 and r.organization_id is null`,
          [org, userId, req.ctx.userId, role],
        );
      });
      await audit(d.pool, req, 'ROLE_CHANGED', 'user_roles', userId, { role });
      return ok({ userId, role }, req.id);
    },
  );

  app.patch(
    `${API}/users/:userId/status`,
    { preHandler: [d.authenticate, requirePermission('user.update')] },
    async (req) => {
      const { userId } = userParams.parse(req.params);
      const { status } = z.object({ status: z.enum(['active', 'suspended']) }).parse(req.body);
      if (userId === req.ctx.userId)
        throw new AppError(400, 'BAD_REQUEST', 'You cannot suspend yourself.');
      const r = await withUser(d.pool, req.ctx.userId, (db) =>
        db.query(
          'update public.organization_members set status = $1, updated_by = $2 where organization_id = $3 and user_id = $4 returning id',
          [status, req.ctx.userId, req.ctx.organization!.id, userId],
        ),
      );
      if (!r.rowCount) throw notFound('User'); // also what an admin gets when targeting the owner (RLS filters the row)
      await audit(d.pool, req, 'USER_STATUS_CHANGED', 'organization_members', userId, { status });
      return ok({ userId, status }, req.id);
    },
  );

  app.get(
    `${API}/roles`,
    { preHandler: [d.authenticate, requirePermission('settings.read')] },
    async (req) => {
      const rows = await withUser(
        d.pool,
        req.ctx.userId,
        async (db) =>
          (
            await db.query(
              `select r.code, r.name, coalesce(array_agg(p.code order by p.code) filter (where p.code is not null), '{}') as permissions
       from public.roles r left join public.role_permissions rp on rp.role_id = r.id left join public.permissions p on p.id = rp.permission_id
       where r.scope = 'organization' and r.organization_id is null group by r.id order by array_position(array['ORGANIZATION_OWNER','ORGANIZATION_ADMIN','TEACHER','STUDENT'], r.code)`,
            )
          ).rows,
      );
      return ok({ roles: rows }, req.id);
    },
  );
}
