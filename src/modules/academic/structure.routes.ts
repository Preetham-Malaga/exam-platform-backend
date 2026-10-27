// PURPOSE: Academic levels (the per-organization names such as Program > Branch > Year) and academic units (the tree nodes).
// WHY: One configurable structure fits engineering colleges, schools, MBA and coaching institutes (guide Part 7) without
//      per-institution code. Every query runs as the caller, so RLS keeps each organization inside its own tree.
// DEPENDS ON: shared.ts, migrations 011/012 (tables), 036 (RLS: members read, academic.manage writes), 042 (tree rules).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser, type Db } from '../../db/context.js';
import { requireOrganization, requirePermission } from '../../middleware/authorization.js';
import { audit } from '../../utils/audit.js';
import { AppError, notFound } from '../../utils/errors.js';
import { likePattern, listQuerySchema, paginate } from '../../utils/pagination.js';
import { ok } from '../../utils/response.js';
import { API, type Deps } from '../deps.js';
import {
  assertActive,
  assertNotInUse,
  buildSet,
  codeSchema,
  idParams,
  nameSchema,
  slug,
  statusSchema,
  withTotal,
} from './shared.js';

const MAX_LEVELS = 10;
const MAX_TREE_UNITS = 5000;

const LEVEL_COLUMNS = `l.id, l.code, l.name, l.position,
  (select count(*)::int from public.academic_units u where u.organization_id = l.organization_id
     and u.level_id = l.id and u.deleted_at is null) as "unitCount"`;

const UNIT_COLUMNS = `u.id, u.code, u.name, u.status, u.level_id as "levelId", l.name as "levelName",
  l.position as "levelPosition", u.parent_id as "parentId", p.name as "parentName",
  (select count(*)::int from public.academic_units c where c.organization_id = u.organization_id
     and c.parent_id = u.id and c.deleted_at is null) as "childCount",
  (select count(*)::int from public.subjects s where s.organization_id = u.organization_id
     and s.academic_unit_id = u.id and s.deleted_at is null) as "subjectCount",
  u.created_at as "createdAt", u.updated_at as "updatedAt"`;
const UNIT_FROM = `public.academic_units u
  join public.academic_levels l on l.organization_id = u.organization_id and l.id = u.level_id
  left join public.academic_units p on p.organization_id = u.organization_id and p.id = u.parent_id`;

const UNIT_SORT: Record<string, string> = {
  name: 'u.name',
  code: 'u.code',
  level: 'l.position',
  createdAt: 'u.created_at',
};

const levelCreate = z.object({ name: nameSchema, code: codeSchema.optional() }).strict();
const levelUpdate = z.object({ name: nameSchema, code: codeSchema }).partial().strict();
const levelOrder = z.object({ levelIds: z.array(z.uuid()).min(1).max(MAX_LEVELS) }).strict();

const unitCreate = z
  .object({
    levelId: z.uuid(),
    parentId: z.uuid().nullable().optional(),
    code: codeSchema,
    name: nameSchema,
  })
  .strict();
const unitUpdate = z
  .object({
    levelId: z.uuid(),
    parentId: z.uuid().nullable(),
    code: codeSchema,
    name: nameSchema,
    status: statusSchema,
  })
  .partial()
  .strict();
const unitFilters = z.object({
  levelId: z.uuid().optional(),
  parentId: z.union([z.literal('root'), z.uuid()]).optional(),
  status: statusSchema.optional(),
});

async function getLevel(db: Db, org: string, id: string) {
  const r = await db.query(
    `select ${LEVEL_COLUMNS} from public.academic_levels l where l.organization_id = $1 and l.id = $2`,
    [org, id],
  );
  if (!r.rows[0]) throw notFound('Level');
  return r.rows[0] as Record<string, unknown>;
}

async function getUnit(db: Db, org: string, id: string) {
  const r = await db.query(
    `select ${UNIT_COLUMNS} from ${UNIT_FROM} where u.organization_id = $1 and u.id = $2 and u.deleted_at is null`,
    [org, id],
  );
  if (!r.rows[0]) throw notFound('Unit');
  return r.rows[0] as Record<string, unknown>;
}

export function registerAcademicStructureRoutes(app: FastifyInstance, d: Deps): void {
  const org = (req: { ctx: { organization: { id: string } | null } }) => req.ctx.organization!.id;

  // ---------- levels ----------
  app.get(
    `${API}/academic-levels`,
    { preHandler: [d.authenticate, requireOrganization()] },
    async (req) => {
      const rows = await withUser(
        d.pool,
        req.ctx.userId,
        async (db) =>
          (
            await db.query(
              `select ${LEVEL_COLUMNS} from public.academic_levels l where l.organization_id = $1 order by l.position`,
              [org(req)],
            )
          ).rows,
      );
      return ok({ items: rows }, req.id);
    },
  );

  app.post(
    `${API}/academic-levels`,
    { preHandler: [d.authenticate, requirePermission('academic.manage')] },
    async (req, reply) => {
      const body = levelCreate.parse(req.body);
      const level = await withUser(d.pool, req.ctx.userId, async (db) => {
        const stats = (
          await db.query(
            'select count(*)::int as n, coalesce(max(position), 0)::int as top from public.academic_levels where organization_id = $1',
            [org(req)],
          )
        ).rows[0] as { n: number; top: number };
        if (stats.n >= MAX_LEVELS)
          throw new AppError(
            400,
            'TOO_MANY_LEVELS',
            `An organization can have at most ${MAX_LEVELS} levels.`,
          );
        const id = (
          await db.query(
            `insert into public.academic_levels (organization_id, code, name, position) values ($1,$2,$3,$4) returning id`,
            [org(req), body.code ?? slug(body.name), body.name, stats.top + 1],
          )
        ).rows[0].id as string;
        return getLevel(db, org(req), id);
      });
      await audit(d.pool, req, 'ACADEMIC_LEVEL_CREATED', 'academic_levels', level.id as string);
      reply.code(201);
      return ok(level, req.id);
    },
  );

  app.patch(
    `${API}/academic-levels/:id`,
    { preHandler: [d.authenticate, requirePermission('academic.manage')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const body = levelUpdate.parse(req.body);
      const { sets, vals } = buildSet(body, { name: 'name', code: 'code' });
      const level = await withUser(d.pool, req.ctx.userId, async (db) => {
        if (sets.length) {
          vals.push(req.ctx.userId, org(req), id);
          const n = vals.length;
          const r = await db.query(
            `update public.academic_levels set ${sets.join(', ')}, updated_by = $${n - 2}
             where organization_id = $${n - 1} and id = $${n}`,
            vals,
          );
          if (!r.rowCount) throw notFound('Level');
        }
        return getLevel(db, org(req), id);
      });
      if (sets.length)
        await audit(d.pool, req, 'ACADEMIC_LEVEL_UPDATED', 'academic_levels', id, body);
      return ok(level, req.id);
    },
  );

  // Replaces the whole order at once. Refused if it would put a unit on a level at or above its parent's level.
  app.put(
    `${API}/academic-levels/order`,
    { preHandler: [d.authenticate, requirePermission('academic.manage')] },
    async (req) => {
      const { levelIds } = levelOrder.parse(req.body);
      const rows = await withUser(d.pool, req.ctx.userId, async (db) => {
        const current = (
          await db.query('select id from public.academic_levels where organization_id = $1', [
            org(req),
          ])
        ).rows.map((r) => r.id as string);
        const same =
          new Set(levelIds).size === levelIds.length &&
          levelIds.length === current.length &&
          current.every((c) => levelIds.includes(c));
        if (!same)
          throw new AppError(
            400,
            'BAD_REQUEST',
            'Send every level of your organization exactly once.',
          );
        // (organization_id, position) is unique and checked row by row: park the rows out of the way first.
        await db.query(
          'update public.academic_levels set position = position + 1000 where organization_id = $1',
          [org(req)],
        );
        for (const [i, id] of levelIds.entries())
          await db.query(
            'update public.academic_levels set position = $1, updated_by = $2 where organization_id = $3 and id = $4',
            [i + 1, req.ctx.userId, org(req), id],
          );
        const broken = await db.query(
          `select 1 from public.academic_units u
           join public.academic_levels l on l.organization_id = u.organization_id and l.id = u.level_id
           join public.academic_units p on p.organization_id = u.organization_id and p.id = u.parent_id
           join public.academic_levels pl on pl.organization_id = p.organization_id and pl.id = p.level_id
           where u.organization_id = $1 and u.deleted_at is null and p.deleted_at is null and pl.position >= l.position
           limit 1`,
          [org(req)],
        );
        if (broken.rowCount)
          throw new AppError(
            409,
            'LEVEL_ORDER_CONFLICT',
            'This order would put some units above their parent. Move those units first.',
          );
        return (
          await db.query(
            `select ${LEVEL_COLUMNS} from public.academic_levels l where l.organization_id = $1 order by l.position`,
            [org(req)],
          )
        ).rows;
      });
      await audit(d.pool, req, 'ACADEMIC_LEVELS_REORDERED', 'academic_levels', null, { levelIds });
      return ok({ items: rows }, req.id);
    },
  );

  app.delete(
    `${API}/academic-levels/:id`,
    { preHandler: [d.authenticate, requirePermission('academic.manage')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      await assertNotInUse(
        d.pool,
        org(req),
        id,
        'LEVEL_IN_USE',
        'Units still use this level. Delete or move them first.',
        { units: { table: 'academic_units', column: 'level_id' } },
      );
      await withUser(d.pool, req.ctx.userId, async (db) => {
        const r = await db.query(
          'delete from public.academic_levels where organization_id = $1 and id = $2',
          [org(req), id],
        );
        if (!r.rowCount) throw notFound('Level');
      });
      await audit(d.pool, req, 'ACADEMIC_LEVEL_DELETED', 'academic_levels', id);
      return ok({ deleted: true }, req.id);
    },
  );

  // ---------- units ----------
  app.get(
    `${API}/academic-units`,
    { preHandler: [d.authenticate, requireOrganization()] },
    async (req) => {
      const q = listQuerySchema.parse(req.query);
      const f = unitFilters.parse(req.query);
      const params: unknown[] = [org(req)];
      const where = ['u.organization_id = $1', 'u.deleted_at is null'];
      if (f.levelId) where.push(`u.level_id = $${params.push(f.levelId)}`);
      if (f.parentId === 'root') where.push('u.parent_id is null');
      else if (f.parentId) where.push(`u.parent_id = $${params.push(f.parentId)}`);
      if (f.status) where.push(`u.status = $${params.push(f.status)}`);
      if (q.search) {
        const p = params.push(likePattern(q.search));
        where.push(`(u.name ilike $${p} or u.code ilike $${p})`);
      }
      params.push(q.pageSize, (q.page - 1) * q.pageSize);
      const rows = await withUser(
        d.pool,
        req.ctx.userId,
        async (db) =>
          (
            await db.query(
              `select ${UNIT_COLUMNS}, count(*) over() as "__total" from ${UNIT_FROM}
               where ${where.join(' and ')}
               order by ${UNIT_SORT[q.sort ?? 'level'] ?? UNIT_SORT.level} ${q.order === 'desc' ? 'desc' : 'asc'}, u.name, u.id
               limit $${params.length - 1} offset $${params.length}`,
              params,
            )
          ).rows,
      );
      const { items, total } = withTotal(rows);
      return ok(paginate(items, total, q), req.id);
    },
  );

  // The whole structure in one call for tree screens and pickers (flat list; the client nests by parentId).
  app.get(
    `${API}/academic-units/tree`,
    { preHandler: [d.authenticate, requireOrganization()] },
    async (req) => {
      const data = await withUser(d.pool, req.ctx.userId, async (db) => {
        const levels = (
          await db.query(
            `select ${LEVEL_COLUMNS} from public.academic_levels l where l.organization_id = $1 order by l.position`,
            [org(req)],
          )
        ).rows;
        const units = (
          await db.query(
            `select u.id, u.code, u.name, u.status, u.level_id as "levelId", u.parent_id as "parentId"
             from public.academic_units u
             join public.academic_levels l on l.organization_id = u.organization_id and l.id = u.level_id
             where u.organization_id = $1 and u.deleted_at is null
             order by l.position, u.name, u.id limit $2`,
            [org(req), MAX_TREE_UNITS + 1],
          )
        ).rows;
        return {
          levels,
          units: units.slice(0, MAX_TREE_UNITS),
          truncated: units.length > MAX_TREE_UNITS,
        };
      });
      return ok(data, req.id);
    },
  );

  app.get(
    `${API}/academic-units/:id`,
    { preHandler: [d.authenticate, requireOrganization()] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      return ok(await withUser(d.pool, req.ctx.userId, (db) => getUnit(db, org(req), id)), req.id);
    },
  );

  app.post(
    `${API}/academic-units`,
    { preHandler: [d.authenticate, requirePermission('academic.manage')] },
    async (req, reply) => {
      const body = unitCreate.parse(req.body);
      const unit = await withUser(d.pool, req.ctx.userId, async (db) => {
        await assertActive(db, 'academic_levels', org(req), body.levelId, 'Level');
        const id = (
          await db.query(
            `insert into public.academic_units (organization_id, level_id, parent_id, code, name)
             values ($1,$2,$3,$4,$5) returning id`,
            [org(req), body.levelId, body.parentId ?? null, body.code, body.name],
          )
        ).rows[0].id as string;
        return getUnit(db, org(req), id);
      });
      await audit(d.pool, req, 'ACADEMIC_UNIT_CREATED', 'academic_units', unit.id as string);
      reply.code(201);
      return ok(unit, req.id);
    },
  );

  app.patch(
    `${API}/academic-units/:id`,
    { preHandler: [d.authenticate, requirePermission('academic.manage')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const body = unitUpdate.parse(req.body);
      if (body.parentId === id)
        throw new AppError(400, 'INVALID_PARENT_UNIT', 'A unit cannot be its own parent.');
      const { sets, vals } = buildSet(body, {
        levelId: 'level_id',
        parentId: 'parent_id',
        code: 'code',
        name: 'name',
        status: 'status',
      });
      const unit = await withUser(d.pool, req.ctx.userId, async (db) => {
        if (body.levelId)
          await assertActive(db, 'academic_levels', org(req), body.levelId, 'Level');
        if (sets.length) {
          vals.push(req.ctx.userId, org(req), id);
          const n = vals.length;
          const r = await db.query(
            `update public.academic_units set ${sets.join(', ')}, updated_by = $${n - 2}
             where organization_id = $${n - 1} and id = $${n} and deleted_at is null`,
            vals,
          );
          if (!r.rowCount) throw notFound('Unit');
        }
        return getUnit(db, org(req), id);
      });
      if (sets.length)
        await audit(d.pool, req, 'ACADEMIC_UNIT_UPDATED', 'academic_units', id, body);
      return ok(unit, req.id);
    },
  );

  // Soft delete (history stays). Refused while anything active still hangs off the unit.
  app.delete(
    `${API}/academic-units/:id`,
    { preHandler: [d.authenticate, requirePermission('academic.manage')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      await assertNotInUse(
        d.pool,
        org(req),
        id,
        'UNIT_IN_USE',
        'This unit still has sub-units, courses, subjects or students. Move or delete them first.',
        {
          units: { table: 'academic_units', column: 'parent_id' },
          courses: { table: 'courses', column: 'academic_unit_id' },
          subjects: { table: 'subjects', column: 'academic_unit_id' },
          students: { table: 'students', column: 'academic_unit_id' },
        },
      );
      await withUser(d.pool, req.ctx.userId, async (db) => {
        const r = await db.query(
          `update public.academic_units set deleted_at = now(), updated_by = $1
           where organization_id = $2 and id = $3 and deleted_at is null`,
          [req.ctx.userId, org(req), id],
        );
        if (!r.rowCount) throw notFound('Unit');
      });
      await audit(d.pool, req, 'ACADEMIC_UNIT_DELETED', 'academic_units', id);
      return ok({ deleted: true }, req.id);
    },
  );
}
