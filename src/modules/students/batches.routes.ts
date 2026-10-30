// PURPOSE: Batches (prototype People › Batches, SPEC.batch): list with student counts, read, create, update, delete.
// WHY: Students are grouped into batches; exams, classes and materials reach students through their batch. Batches
//      follow the student permissions and run as the caller, so RLS (migration 045) limits them to the organization.
// DEPENDS ON: migration 045 (batches, students.batch_id), academic/shared.ts helpers.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser, type Db } from '../../db/context.js';
import { requirePermission } from '../../middleware/authorization.js';
import { audit } from '../../utils/audit.js';
import { AppError, notFound } from '../../utils/errors.js';
import { ok } from '../../utils/response.js';
import { assertActive, buildSet, codeSchema, idParams, statusSchema } from '../academic/shared.js';
import { API, type Deps } from '../deps.js';

const text = (max: number) => z.string().trim().max(max).nullable();
const fields = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(80),
  courseId: z.uuid().nullable(),
  academicYear: text(20),
  yearSem: text(30),
  section: text(10),
  mode: z.enum(['Offline', 'Online', 'Hybrid']).nullable(),
  timing: z.enum(['Morning', 'Afternoon', 'Evening', 'Weekend']).nullable(),
  startDate: z.iso.date().nullable(),
  endDate: z.iso.date().nullable(),
  capacity: z.number().int().min(1).max(1000).nullable(),
  classTeacherId: z.uuid().nullable(),
  room: text(30),
  status: statusSchema,
});
const datesOk = (
  v: { startDate?: string | null; endDate?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (v.startDate && v.endDate && v.endDate < v.startDate)
    ctx.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: 'Must be on or after the start date.',
    });
};
const createSchema = fields
  .partial()
  .required({ code: true, name: true })
  .strict()
  .superRefine(datesOk);
const updateSchema = fields.partial().strict().superRefine(datesOk);

const COLUMN_MAP = {
  code: 'code',
  name: 'name',
  courseId: 'course_id',
  academicYear: 'academic_year',
  yearSem: 'year_sem',
  section: 'section',
  mode: 'mode',
  timing: 'timing',
  startDate: 'start_date',
  endDate: 'end_date',
  capacity: 'capacity',
  classTeacherId: 'class_teacher_id',
  room: 'room',
  status: 'status',
} as const;

const COLUMNS = `b.id, b.code, b.name, b.course_id as "courseId", c.name as "courseName",
  b.academic_year as "academicYear", b.year_sem as "yearSem", b.section, b.mode, b.timing,
  to_char(b.start_date, 'YYYY-MM-DD') as "startDate", to_char(b.end_date, 'YYYY-MM-DD') as "endDate",
  b.capacity, b.class_teacher_id as "classTeacherId", t.full_name as "classTeacherName", b.room, b.status,
  (select count(*)::int from public.students s where s.organization_id = b.organization_id
     and s.batch_id = b.id and s.deleted_at is null) as "studentCount",
  b.created_at as "createdAt", b.updated_at as "updatedAt"`;
const FROM = `public.batches b
  left join public.courses c on c.organization_id = b.organization_id and c.id = b.course_id
  left join public.teachers t on t.organization_id = b.organization_id and t.id = b.class_teacher_id`;

async function getBatch(db: Db, org: string, id: string) {
  const r = await db.query(
    `select ${COLUMNS} from ${FROM} where b.organization_id = $1 and b.id = $2 and b.deleted_at is null`,
    [org, id],
  );
  if (!r.rows[0]) throw notFound('Batch');
  return r.rows[0] as Record<string, unknown>;
}

/** Inside the caller's transaction: the referenced course and class teacher exist in the organization. */
async function checkRefs(
  db: Db,
  org: string,
  b: { courseId?: string | null; classTeacherId?: string | null },
) {
  if (b.courseId) await assertActive(db, 'courses', org, b.courseId, 'Course');
  if (b.classTeacherId) {
    const t = await db.query(
      'select 1 from public.teachers where organization_id = $1 and id = $2 and deleted_at is null',
      [org, b.classTeacherId],
    );
    if (!t.rowCount) throw notFound('Teacher');
  }
}

const codeTaken = (err: unknown) =>
  (err as { code?: string; constraint?: string }).code === '23505'
    ? new AppError(409, 'BATCH_CODE_TAKEN', 'This batch code is already used.', undefined, 'code')
    : err;

export function registerBatchRoutes(app: FastifyInstance, d: Deps): void {
  const org = (req: { ctx: { organization: { id: string } | null } }) => req.ctx.organization!.id;

  app.get(
    `${API}/batches`,
    { preHandler: [d.authenticate, requirePermission('student.read')] },
    async (req) => {
      const f = z.object({ courseId: z.uuid().optional() }).parse(req.query);
      const params: unknown[] = [org(req)];
      const where = ['b.organization_id = $1', 'b.deleted_at is null'];
      if (f.courseId) where.push(`b.course_id = $${params.push(f.courseId)}`);
      const data = await withUser(d.pool, req.ctx.userId, async (db) => {
        const items = (
          await db.query(
            `select ${COLUMNS} from ${FROM} where ${where.join(' and ')} order by b.name, b.id limit 1000`,
            params,
          )
        ).rows;
        const noBatch = (
          await db.query(
            `select count(*)::int as n from public.students where organization_id = $1
             and deleted_at is null and batch_id is null`,
            [org(req)],
          )
        ).rows[0].n as number;
        return { items, studentsWithoutBatch: noBatch };
      });
      return ok(data, req.id);
    },
  );

  app.get(
    `${API}/batches/:id`,
    { preHandler: [d.authenticate, requirePermission('student.read')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      return ok(await withUser(d.pool, req.ctx.userId, (db) => getBatch(db, org(req), id)), req.id);
    },
  );

  app.post(
    `${API}/batches`,
    { preHandler: [d.authenticate, requirePermission('student.create')] },
    async (req, reply) => {
      const body = createSchema.parse(req.body);
      const { sets, vals } = buildSet(body, COLUMN_MAP);
      const batch = await withUser(d.pool, req.ctx.userId, async (db) => {
        await checkRefs(db, org(req), body);
        const cols = sets.map((s) => s.split(' = ')[0]);
        vals.push(org(req));
        const id = await db
          .query(
            `insert into public.batches (${cols.join(', ')}, organization_id)
             values (${vals.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
            vals,
          )
          .then((r) => r.rows[0].id as string)
          .catch((e: unknown) => {
            throw codeTaken(e);
          });
        return getBatch(db, org(req), id);
      });
      await audit(d.pool, req, 'BATCH_CREATED', 'batches', batch.id as string);
      reply.code(201);
      return ok(batch, req.id);
    },
  );

  app.patch(
    `${API}/batches/:id`,
    { preHandler: [d.authenticate, requirePermission('student.update')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const body = updateSchema.parse(req.body);
      const { sets, vals } = buildSet(body, COLUMN_MAP);
      const batch = await withUser(d.pool, req.ctx.userId, async (db) => {
        await checkRefs(db, org(req), body);
        if (sets.length) {
          vals.push(req.ctx.userId, org(req), id);
          const n = vals.length;
          const r = await db
            .query(
              `update public.batches set ${sets.join(', ')}, updated_by = $${n - 2}
               where organization_id = $${n - 1} and id = $${n} and deleted_at is null`,
              vals,
            )
            .catch((e: unknown) => {
              throw codeTaken(e);
            });
          if (!r.rowCount) throw notFound('Batch');
        }
        return getBatch(db, org(req), id);
      });
      if (sets.length) await audit(d.pool, req, 'BATCH_UPDATED', 'batches', id, body);
      return ok(batch, req.id);
    },
  );

  app.delete(
    `${API}/batches/:id`,
    { preHandler: [d.authenticate, requirePermission('student.delete')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      await withUser(d.pool, req.ctx.userId, async (db) => {
        const b = await getBatch(db, org(req), id);
        if ((b.studentCount as number) > 0)
          throw new AppError(
            409,
            'BATCH_IN_USE',
            'Students are still in this batch. Move them to another batch first.',
          );
        await db.query(
          `update public.batches set deleted_at = now(), updated_by = $1 where organization_id = $2 and id = $3`,
          [req.ctx.userId, org(req), id],
        );
      });
      await audit(d.pool, req, 'BATCH_DELETED', 'batches', id);
      return ok({ deleted: true }, req.id);
    },
  );
}
