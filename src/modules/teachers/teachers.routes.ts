// PURPOSE: Teacher management: teacher records, their sign-in (invitation), activation/removal and their scope
//          (the subjects, courses or academic units they may work in).
// WHY: Guide Part 18 step 10. A teacher's permissions come from the TEACHER role; WHAT they can touch comes from user_scopes,
//      which every question/exam/topic policy checks through app.in_scope (migration 036).
// DEPENDS ON: _shared/member.ts (login linking), tables teachers (017), user_scopes (010), trigger
//             validate_user_scope (038), academic/shared.ts helpers.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser, type Db } from '../../db/context.js';
import { requirePermission } from '../../middleware/authorization.js';
import { audit } from '../../utils/audit.js';
import { AppError, notFound } from '../../utils/errors.js';
import { likePattern, listQuerySchema, paginate } from '../../utils/pagination.js';
import { ok } from '../../utils/response.js';
import {
  TEACHER,
  linkLogin,
  personEmailSchema as emailSchema,
  personNameSchema as nameSchema,
  personPhoneSchema as phoneSchema,
  removeMembership,
  syncMembershipStatus,
} from '../_shared/member.js';
import { buildSet, codeSchema, idParams, statusSchema, withTotal } from '../academic/shared.js';
import { API, type Deps } from '../deps.js';

const MAX_SCOPES = 200;

const createSchema = z
  .object({
    employeeCode: codeSchema,
    fullName: nameSchema,
    email: emailSchema.nullable().optional(),
    phone: phoneSchema.optional(),
    /** Create the login and send the invitation e-mail now (default). */
    invite: z.boolean().default(true),
  })
  .strict();
const updateSchema = z
  .object({
    employeeCode: codeSchema,
    fullName: nameSchema,
    email: emailSchema.nullable(),
    phone: phoneSchema,
    status: statusSchema,
  })
  .partial()
  .strict();
const SCOPE_TABLE = {
  subject: 'subjects',
  course: 'courses',
  academic_unit: 'academic_units',
} as const;
const scopesSchema = z
  .object({
    scopes: z
      .array(
        z
          .object({ scopeType: z.enum(['subject', 'course', 'academic_unit']), scopeId: z.uuid() })
          .strict(),
      )
      .max(MAX_SCOPES),
  })
  .strict();

const SORT: Record<string, string> = {
  fullName: 't.full_name',
  employeeCode: 't.employee_code',
  createdAt: 't.created_at',
};
const COLUMNS = `t.id, t.employee_code as "employeeCode", t.full_name as "fullName", t.email, t.phone, t.status,
  t.user_id as "userId", m.status as "accountStatus",
  (select count(*)::int from public.user_scopes us
    where us.organization_id = t.organization_id and us.user_id = t.user_id) as "scopeCount",
  t.created_at as "createdAt", t.updated_at as "updatedAt"`;
const FROM = `public.teachers t
  left join public.organization_members m on m.organization_id = t.organization_id and m.user_id = t.user_id`;

type Row = Record<string, unknown>;

async function getTeacher(db: Db, org: string, id: string): Promise<Row> {
  const r = await db.query(
    `select ${COLUMNS} from ${FROM} where t.organization_id = $1 and t.id = $2 and t.deleted_at is null`,
    [org, id],
  );
  if (!r.rows[0]) throw notFound('Teacher');
  return r.rows[0] as Row;
}

async function getScopes(db: Db, org: string, userId: string | null): Promise<Row[]> {
  if (!userId) return [];
  return (
    await db.query(
      `select us.scope_type as "scopeType", us.scope_id as "scopeId",
              coalesce(s.name, c.name, u.name) as name,
              coalesce(s.code, c.code, u.code) as code,
              coalesce(s.deleted_at, c.deleted_at, u.deleted_at) is null as active
       from public.user_scopes us
       left join public.subjects s on us.scope_type = 'subject' and s.organization_id = us.organization_id and s.id = us.scope_id
       left join public.courses c on us.scope_type = 'course' and c.organization_id = us.organization_id and c.id = us.scope_id
       left join public.academic_units u on us.scope_type = 'academic_unit' and u.organization_id = us.organization_id and u.id = us.scope_id
       where us.organization_id = $1 and us.user_id = $2
       order by us.scope_type, 3`,
      [org, userId],
    )
  ).rows as Row[];
}

export function registerTeacherRoutes(app: FastifyInstance, d: Deps): void {
  const org = (req: { ctx: { organization: { id: string } | null } }) => req.ctx.organization!.id;

  app.get(
    `${API}/teachers`,
    { preHandler: [d.authenticate, requirePermission('teacher.read')] },
    async (req) => {
      const q = listQuerySchema.parse(req.query);
      const f = z.object({ status: statusSchema.optional() }).parse(req.query);
      const params: unknown[] = [org(req)];
      const where = ['t.organization_id = $1', 't.deleted_at is null'];
      if (f.status) where.push(`t.status = $${params.push(f.status)}`);
      if (q.search) {
        const p = params.push(likePattern(q.search));
        where.push(
          `(t.full_name ilike $${p} or t.email::text ilike $${p} or t.employee_code ilike $${p})`,
        );
      }
      params.push(q.pageSize, (q.page - 1) * q.pageSize);
      const rows = await withUser(
        d.pool,
        req.ctx.userId,
        async (db) =>
          (
            await db.query(
              `select ${COLUMNS}, count(*) over() as "__total" from ${FROM}
               where ${where.join(' and ')}
               order by ${SORT[q.sort ?? 'fullName'] ?? SORT.fullName} ${q.order === 'desc' ? 'desc' : 'asc'}, t.id
               limit $${params.length - 1} offset $${params.length}`,
              params,
            )
          ).rows,
      );
      const { items, total } = withTotal(rows);
      return ok(paginate(items, total, q), req.id);
    },
  );

  app.get(
    `${API}/teachers/:id`,
    { preHandler: [d.authenticate, requirePermission('teacher.read')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const data = await withUser(d.pool, req.ctx.userId, async (db) => {
        const t = await getTeacher(db, org(req), id);
        return { ...t, scopes: await getScopes(db, org(req), t.userId as string | null) };
      });
      return ok(data, req.id);
    },
  );

  app.post(
    `${API}/teachers`,
    { preHandler: [d.authenticate, requirePermission('teacher.create')] },
    async (req, reply) => {
      const body = createSchema.parse(req.body);
      if (body.invite && !body.email)
        throw new AppError(
          400,
          'EMAIL_REQUIRED',
          'An e-mail address is needed to send the invitation.',
        );
      const values = (userId: string | null) => [
        org(req),
        userId,
        body.employeeCode,
        body.fullName,
        body.email ?? null,
        body.phone ?? null,
        req.ctx.userId,
      ];
      const insert = async (db: Db, userId: string | null) =>
        (
          await db.query(
            `insert into public.teachers (organization_id, user_id, employee_code, full_name, email, phone, created_by)
             values ($1,$2,$3,$4,$5,$6,$7) returning id`,
            values(userId),
          )
        ).rows[0].id as string;
      const id =
        body.invite && body.email
          ? await linkLogin(
              d,
              org(req),
              req.ctx.userId,
              TEACHER,
              { id: null, email: body.email, fullName: body.fullName },
              insert,
            )
          : await withUser(d.pool, req.ctx.userId, (db) => insert(db, null));
      const teacher = await withUser(d.pool, req.ctx.userId, (db) => getTeacher(db, org(req), id));
      await audit(d.pool, req, 'TEACHER_CREATED', 'teachers', id, { invited: body.invite });
      reply.code(201);
      return ok(teacher, req.id);
    },
  );

  // For a teacher record created without a login: create/link the login now and send the invitation.
  app.post(
    `${API}/teachers/:id/invite`,
    { preHandler: [d.authenticate, requirePermission('teacher.create')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const t = await withUser(d.pool, req.ctx.userId, (db) => getTeacher(db, org(req), id));
      if (t.userId) throw new AppError(409, 'ALREADY_INVITED', 'This teacher already has a login.');
      if (!t.email)
        throw new AppError(
          400,
          'EMAIL_REQUIRED',
          'Add an e-mail address before sending the invitation.',
        );
      await linkLogin(d, org(req), req.ctx.userId, TEACHER, {
        id,
        email: t.email as string,
        fullName: t.fullName as string,
      });
      await audit(d.pool, req, 'TEACHER_INVITED', 'teachers', id);
      return ok(
        await withUser(d.pool, req.ctx.userId, (db) => getTeacher(db, org(req), id)),
        req.id,
      );
    },
  );

  app.patch(
    `${API}/teachers/:id`,
    { preHandler: [d.authenticate, requirePermission('teacher.update')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const body = updateSchema.parse(req.body);
      const { sets, vals } = buildSet(body, {
        employeeCode: 'employee_code',
        fullName: 'full_name',
        email: 'email',
        phone: 'phone',
        status: 'status',
      });
      const teacher = await withUser(d.pool, req.ctx.userId, async (db) => {
        const current = await getTeacher(db, org(req), id);
        if (current.userId && body.email !== undefined && body.email !== current.email)
          throw new AppError(
            400,
            'EMAIL_LOCKED',
            'This teacher signs in with this e-mail address, so it cannot be changed here.',
          );
        if (sets.length) {
          vals.push(req.ctx.userId, org(req), id);
          const n = vals.length;
          await db.query(
            `update public.teachers set ${sets.join(', ')}, updated_by = $${n - 2}
             where organization_id = $${n - 1} and id = $${n} and deleted_at is null`,
            vals,
          );
        }
        // Deactivating a teacher locks their login out of the organization (and reactivating lets them back in).
        if (body.status && body.status !== current.status && current.userId)
          await syncMembershipStatus(
            db,
            org(req),
            req.ctx.userId,
            current.userId as string,
            body.status,
          );
        return getTeacher(db, org(req), id);
      });
      if (sets.length) await audit(d.pool, req, 'TEACHER_UPDATED', 'teachers', id, body);
      return ok(teacher, req.id);
    },
  );

  // Recommended removal (guide 13.1): soft-delete the record, remove the membership, clear the scope. History stays.
  app.delete(
    `${API}/teachers/:id`,
    { preHandler: [d.authenticate, requirePermission('teacher.delete')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      await withUser(d.pool, req.ctx.userId, async (db) => {
        const t = await getTeacher(db, org(req), id);
        await db.query(
          `update public.teachers set deleted_at = now(), updated_by = $1 where organization_id = $2 and id = $3`,
          [req.ctx.userId, org(req), id],
        );
        if (t.userId) {
          await db.query(
            'delete from public.user_scopes where organization_id = $1 and user_id = $2',
            [org(req), t.userId],
          );
          await removeMembership(db, org(req), req.ctx.userId, t.userId as string);
        }
      });
      await audit(d.pool, req, 'TEACHER_REMOVED', 'teachers', id);
      return ok({ deleted: true }, req.id);
    },
  );

  // Replaces the whole scope at once (subjects, courses and/or academic units).
  app.put(
    `${API}/teachers/:id/scopes`,
    { preHandler: [d.authenticate, requirePermission('teacher.assign_scope')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const { scopes } = scopesSchema.parse(req.body);
      const unique = [...new Map(scopes.map((s) => [`${s.scopeType}:${s.scopeId}`, s])).values()];
      const data = await withUser(d.pool, req.ctx.userId, async (db) => {
        const t = await getTeacher(db, org(req), id);
        if (!t.userId)
          throw new AppError(
            400,
            'TEACHER_HAS_NO_LOGIN',
            'Send the invitation first: the scope is stored on the teacher login.',
          );
        // Every target must be an active record of this organization (deleted or foreign ids are reported, not stored).
        const missing: string[] = [];
        for (const [type, table] of Object.entries(SCOPE_TABLE)) {
          const ids = unique.filter((s) => s.scopeType === type).map((s) => s.scopeId);
          if (!ids.length) continue;
          const found = new Set(
            (
              await db.query(
                `select id from public.${table} where organization_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
                [org(req), ids],
              )
            ).rows.map((r) => r.id as string),
          );
          missing.push(...ids.filter((x) => !found.has(x)));
        }
        if (missing.length)
          throw new AppError(
            400,
            'INVALID_SCOPE_TARGET',
            'Some of the selected subjects, courses or units do not exist in your organization.',
            { missing },
          );
        await db.query(
          'delete from public.user_scopes where organization_id = $1 and user_id = $2',
          [org(req), t.userId],
        );
        for (const s of unique)
          await db.query(
            `insert into public.user_scopes (organization_id, user_id, scope_type, scope_id, created_by)
             values ($1,$2,$3,$4,$5)`,
            [org(req), t.userId, s.scopeType, s.scopeId, req.ctx.userId],
          );
        return { teacherId: id, scopes: await getScopes(db, org(req), t.userId as string) };
      });
      await audit(d.pool, req, 'TEACHER_SCOPES_CHANGED', 'user_scopes', id, {
        subjects: unique.filter((s) => s.scopeType === 'subject').length,
        courses: unique.filter((s) => s.scopeType === 'course').length,
        units: unique.filter((s) => s.scopeType === 'academic_unit').length,
      });
      return ok(data, req.id);
    },
  );
}
