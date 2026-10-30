// PURPOSE: Student management: records, placement on an academic unit, bulk import, invitation (login),
//          activation and removal.
// WHY: Guide Part 18 step 11. A student's unit decides which exams reach them (exam assignments by unit, app.unit_chain);
//      their login (STUDENT role) lets them sit those exams.
// DEPENDS ON: _shared/member.ts (login linking), table students (016), plan limit trigger (038), academic/shared.ts.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser, type Db } from '../../db/context.js';
import { requirePermission } from '../../middleware/authorization.js';
import { audit } from '../../utils/audit.js';
import { AppError, fromDatabaseError, notFound } from '../../utils/errors.js';
import { likePattern, listQuerySchema, paginate } from '../../utils/pagination.js';
import { ok } from '../../utils/response.js';
import {
  STUDENT,
  linkLogin,
  personEmailSchema,
  personNameSchema,
  personPhoneSchema,
  removeMembership,
  syncMembershipStatus,
} from '../_shared/member.js';
import { assertActive, buildSet, idParams, statusSchema, withTotal } from '../academic/shared.js';
import { API, type Deps } from '../deps.js';

export const MAX_IMPORT_ROWS = 500;

/** Roll numbers are free-form per college ("21CS001", "2021/CS/01"), but never empty or multi-line. */
const rollSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[^\r\n\t]+$/, 'One line only.');

const createSchema = z
  .object({
    rollNumber: rollSchema,
    fullName: personNameSchema,
    email: personEmailSchema.nullable().optional(),
    phone: personPhoneSchema.optional(),
    academicUnitId: z.uuid().nullable().optional(),
    batchId: z.uuid().nullable().optional(),
    /** Create the login and send the invitation e-mail now. */
    invite: z.boolean().default(false),
  })
  .strict();
const updateSchema = z
  .object({
    rollNumber: rollSchema,
    fullName: personNameSchema,
    email: personEmailSchema.nullable(),
    phone: personPhoneSchema,
    academicUnitId: z.uuid().nullable(),
    batchId: z.uuid().nullable(),
    status: statusSchema,
  })
  .partial()
  .strict();

/** Empty cells from a spreadsheet arrive as "" and mean "no value". */
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const importRowSchema = z
  .object({
    rollNumber: rollSchema,
    fullName: personNameSchema,
    email: z.preprocess(blankToNull, personEmailSchema.nullable()).optional(),
    phone: z.preprocess(blankToNull, personPhoneSchema).optional(),
    unitCode: z.preprocess(blankToNull, z.string().trim().max(30).nullable()).optional(),
  })
  .strict();
const importSchema = z
  .object({
    // rows are validated one by one below, so one bad row is reported instead of failing the whole file
    rows: z.array(z.unknown()).min(1).max(MAX_IMPORT_ROWS),
    dryRun: z.boolean().default(false),
  })
  .strict();

const SORT: Record<string, string> = {
  fullName: 's.full_name',
  rollNumber: 's.roll_number',
  createdAt: 's.created_at',
};
const COLUMNS = `s.id, s.roll_number as "rollNumber", s.full_name as "fullName", s.email, s.phone, s.status,
  s.academic_unit_id as "academicUnitId", u.name as "academicUnitName",
  s.batch_id as "batchId", bt.name as "batchName",
  s.user_id as "userId", m.status as "accountStatus",
  s.created_at as "createdAt", s.updated_at as "updatedAt"`;
const FROM = `public.students s
  left join public.academic_units u on u.organization_id = s.organization_id and u.id = s.academic_unit_id
  left join public.batches bt on bt.organization_id = s.organization_id and bt.id = s.batch_id
  left join public.organization_members m on m.organization_id = s.organization_id and m.user_id = s.user_id`;

type Row = Record<string, unknown>;

async function getStudent(db: Db, org: string, id: string): Promise<Row> {
  const r = await db.query(
    `select ${COLUMNS} from ${FROM} where s.organization_id = $1 and s.id = $2 and s.deleted_at is null`,
    [org, id],
  );
  if (!r.rows[0]) throw notFound('Student');
  return r.rows[0] as Row;
}

interface ImportFailure {
  row: number;
  rollNumber: string | null;
  code: string;
  message: string;
}

/** The batch exists in the caller's organization (a clear 404 instead of a foreign-key error). */
async function assertBatch(d: Deps, userId: string, org: string, batchId: string): Promise<void> {
  const found = await withUser(d.pool, userId, (db) =>
    db.query(
      'select 1 from public.batches where organization_id = $1 and id = $2 and deleted_at is null',
      [org, batchId],
    ),
  );
  if (!found.rowCount) throw notFound('Batch');
}

export function registerStudentRoutes(app: FastifyInstance, d: Deps): void {
  const org = (req: { ctx: { organization: { id: string } | null } }) => req.ctx.organization!.id;

  app.get(
    `${API}/students`,
    { preHandler: [d.authenticate, requirePermission('student.read')] },
    async (req) => {
      const q = listQuerySchema.parse(req.query);
      const f = z
        .object({
          status: statusSchema.optional(),
          /** The unit AND every unit below it (all of EEE, including EEE > Year 2). */
          academicUnitId: z.uuid().optional(),
          /** Students not placed on any unit yet. */
          unplaced: z.enum(['true', 'false']).optional(),
          batchId: z.uuid().optional(),
          /** Students without a batch (they receive no batch-assigned exams, classes or materials). */
          noBatch: z.enum(['true', 'false']).optional(),
        })
        .parse(req.query);
      const params: unknown[] = [org(req)];
      const where = ['s.organization_id = $1', 's.deleted_at is null'];
      if (f.status) where.push(`s.status = $${params.push(f.status)}`);
      if (f.noBatch === 'true') where.push('s.batch_id is null');
      else if (f.batchId) where.push(`s.batch_id = $${params.push(f.batchId)}`);
      if (f.unplaced === 'true') where.push('s.academic_unit_id is null');
      else if (f.academicUnitId) {
        const p = params.push(f.academicUnitId);
        where.push(`s.academic_unit_id in (
          with recursive sub as (
            select x.id from public.academic_units x where x.organization_id = $1 and x.id = $${p}
            union
            select x.id from public.academic_units x join sub on x.parent_id = sub.id where x.organization_id = $1
          ) select id from sub)`);
      }
      if (q.search) {
        const p = params.push(likePattern(q.search));
        where.push(
          `(s.full_name ilike $${p} or s.roll_number ilike $${p} or s.email::text ilike $${p})`,
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
               order by ${SORT[q.sort ?? 'rollNumber'] ?? SORT.rollNumber} ${q.order === 'desc' ? 'desc' : 'asc'}, s.id
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
    `${API}/students/:id`,
    { preHandler: [d.authenticate, requirePermission('student.read')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      return ok(
        await withUser(d.pool, req.ctx.userId, (db) => getStudent(db, org(req), id)),
        req.id,
      );
    },
  );

  app.post(
    `${API}/students`,
    { preHandler: [d.authenticate, requirePermission('student.create')] },
    async (req, reply) => {
      const body = createSchema.parse(req.body);
      if (body.invite && !body.email)
        throw new AppError(
          400,
          'EMAIL_REQUIRED',
          'An e-mail address is needed to send the invitation.',
        );
      if (body.academicUnitId)
        await withUser(d.pool, req.ctx.userId, (db) =>
          assertActive(db, 'academic_units', org(req), body.academicUnitId!, 'Unit'),
        );
      if (body.batchId) await assertBatch(d, req.ctx.userId, org(req), body.batchId);
      const insert = async (db: Db, userId: string | null) =>
        (
          await db.query(
            `insert into public.students
               (organization_id, user_id, roll_number, full_name, email, phone, academic_unit_id, created_by, batch_id)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
            [
              org(req),
              userId,
              body.rollNumber,
              body.fullName,
              body.email ?? null,
              body.phone ?? null,
              body.academicUnitId ?? null,
              req.ctx.userId,
              body.batchId ?? null,
            ],
          )
        ).rows[0].id as string;
      // If only the invitation e-mail fails (mailer limit, mail server down), the student is still saved without a
      // login and the reply says why; the invitation can be sent again from the student's row.
      let inviteError: { code: string; message: string } | null = null;
      let id: string;
      try {
        id =
          body.invite && body.email
            ? await linkLogin(
                d,
                org(req),
                req.ctx.userId,
                STUDENT,
                { id: null, email: body.email, fullName: body.fullName },
                insert,
              )
            : await withUser(d.pool, req.ctx.userId, (db) => insert(db, null));
      } catch (err) {
        if (
          !(err instanceof AppError) ||
          !['EMAIL_RATE_LIMITED', 'INVITE_FAILED'].includes(err.code)
        )
          throw err;
        inviteError = { code: err.code, message: err.message };
        id = await withUser(d.pool, req.ctx.userId, (db) => insert(db, null));
      }
      const student = await withUser(d.pool, req.ctx.userId, (db) => getStudent(db, org(req), id));
      await audit(d.pool, req, 'STUDENT_CREATED', 'students', id, {
        invited: body.invite && !inviteError,
      });
      reply.code(201);
      return ok({ ...student, inviteError }, req.id);
    },
  );

  // Bulk import (CSV parsed in the browser). Never sends e-mails: invitations go one by one (or via the job queue later).
  app.post(
    `${API}/students/import`,
    { preHandler: [d.authenticate, requirePermission('student.import')] },
    async (req) => {
      const { rows, dryRun } = importSchema.parse(req.body);
      const failures: ImportFailure[] = [];
      const fail = (i: number, rollNumber: string | null, code: string, message: string) =>
        failures.push({ row: i + 1, rollNumber, code, message });

      const result = await withUser(d.pool, req.ctx.userId, async (db) => {
        const units = new Map<string, string>(
          (
            await db.query(
              'select lower(code) as code, id from public.academic_units where organization_id = $1 and deleted_at is null',
              [org(req)],
            )
          ).rows.map((u) => [u.code as string, u.id as string]),
        );
        const seen = new Set<string>();
        let created = 0;
        await db.query('savepoint import_all');
        for (const [i, raw] of rows.entries()) {
          const parsed = importRowSchema.safeParse(raw);
          if (!parsed.success) {
            const roll =
              typeof (raw as Row | null)?.rollNumber === 'string'
                ? ((raw as Row).rollNumber as string)
                : null;
            fail(
              i,
              roll,
              'INVALID_ROW',
              parsed.error.issues
                .map((x) => `${x.path.join('.') || 'row'}: ${x.message}`)
                .join('; '),
            );
            continue;
          }
          const r = parsed.data;
          if (seen.has(r.rollNumber)) {
            fail(
              i,
              r.rollNumber,
              'DUPLICATE_IN_FILE',
              'This roll number appears earlier in the file.',
            );
            continue;
          }
          seen.add(r.rollNumber);
          const unitId = r.unitCode ? units.get(r.unitCode.toLowerCase()) : null;
          if (r.unitCode && !unitId) {
            fail(i, r.rollNumber, 'UNKNOWN_UNIT', `No unit with code "${r.unitCode}".`);
            continue;
          }
          await db.query('savepoint import_row');
          try {
            await db.query(
              `insert into public.students
                 (organization_id, roll_number, full_name, email, phone, academic_unit_id, created_by)
               values ($1,$2,$3,$4,$5,$6,$7)`,
              [
                org(req),
                r.rollNumber,
                r.fullName,
                r.email ?? null,
                r.phone ?? null,
                unitId ?? null,
                req.ctx.userId,
              ],
            );
            await db.query('release savepoint import_row');
            created += 1;
          } catch (err) {
            await db.query('rollback to savepoint import_row');
            await db.query('release savepoint import_row');
            const known = fromDatabaseError(err);
            if (!known) throw err;
            fail(
              i,
              r.rollNumber,
              known.code,
              known.code === 'DUPLICATE'
                ? 'A student with this roll number already exists.'
                : known.message,
            );
          }
        }
        if (dryRun) await db.query('rollback to savepoint import_all');
        return { total: rows.length, created, failed: failures, dryRun };
      });
      if (!dryRun)
        await audit(d.pool, req, 'STUDENTS_IMPORTED', 'students', null, {
          total: result.total,
          created: result.created,
          failed: failures.length,
        });
      return ok(result, req.id);
    },
  );

  app.post(
    `${API}/students/:id/invite`,
    { preHandler: [d.authenticate, requirePermission('student.create')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const s = await withUser(d.pool, req.ctx.userId, (db) => getStudent(db, org(req), id));
      if (s.userId) throw new AppError(409, 'ALREADY_INVITED', 'This student already has a login.');
      if (!s.email)
        throw new AppError(
          400,
          'EMAIL_REQUIRED',
          'Add an e-mail address before sending the invitation.',
        );
      await linkLogin(d, org(req), req.ctx.userId, STUDENT, {
        id,
        email: s.email as string,
        fullName: s.fullName as string,
      });
      await audit(d.pool, req, 'STUDENT_INVITED', 'students', id);
      return ok(
        await withUser(d.pool, req.ctx.userId, (db) => getStudent(db, org(req), id)),
        req.id,
      );
    },
  );

  app.patch(
    `${API}/students/:id`,
    { preHandler: [d.authenticate, requirePermission('student.update')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const body = updateSchema.parse(req.body);
      const { sets, vals } = buildSet(body, {
        rollNumber: 'roll_number',
        fullName: 'full_name',
        email: 'email',
        phone: 'phone',
        academicUnitId: 'academic_unit_id',
        batchId: 'batch_id',
        status: 'status',
      });
      if (body.batchId) await assertBatch(d, req.ctx.userId, org(req), body.batchId);
      const student = await withUser(d.pool, req.ctx.userId, async (db) => {
        const current = await getStudent(db, org(req), id);
        if (current.userId && body.email !== undefined && body.email !== current.email)
          throw new AppError(
            400,
            'EMAIL_LOCKED',
            'This student signs in with this e-mail address, so it cannot be changed here.',
          );
        if (body.academicUnitId)
          await assertActive(db, 'academic_units', org(req), body.academicUnitId, 'Unit');
        if (sets.length) {
          vals.push(req.ctx.userId, org(req), id);
          const n = vals.length;
          await db.query(
            `update public.students set ${sets.join(', ')}, updated_by = $${n - 2}
             where organization_id = $${n - 1} and id = $${n} and deleted_at is null`,
            vals,
          );
        }
        if (body.status && body.status !== current.status && current.userId)
          await syncMembershipStatus(
            db,
            org(req),
            req.ctx.userId,
            current.userId as string,
            body.status,
          );
        return getStudent(db, org(req), id);
      });
      if (sets.length) await audit(d.pool, req, 'STUDENT_UPDATED', 'students', id, body);
      return ok(student, req.id);
    },
  );

  // Recommended removal (guide 13.1): soft delete + membership removed. Attempts and results stay for reports.
  app.delete(
    `${API}/students/:id`,
    { preHandler: [d.authenticate, requirePermission('student.delete')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      await withUser(d.pool, req.ctx.userId, async (db) => {
        const s = await getStudent(db, org(req), id);
        await db.query(
          `update public.students set deleted_at = now(), updated_by = $1 where organization_id = $2 and id = $3`,
          [req.ctx.userId, org(req), id],
        );
        if (s.userId) await removeMembership(db, org(req), req.ctx.userId, s.userId as string);
      });
      await audit(d.pool, req, 'STUDENT_REMOVED', 'students', id);
      return ok({ deleted: true }, req.id);
    },
  );
}
