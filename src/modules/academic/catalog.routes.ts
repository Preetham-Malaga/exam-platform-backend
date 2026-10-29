// PURPOSE: Courses, subjects and topics: the academic catalogue that questions and exams hang off.
// WHY: Owners/admins manage courses and subjects; teachers read only what they are scoped to and manage topics of their own
//      subjects. Every query runs as the caller, so RLS (course_in_scope / in_scope, migration 036) decides visibility.
// DEPENDS ON: shared.ts, migrations 013-015 (tables), 036 (policies), 018 (questions reference subjects/topics).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser, type Db } from '../../db/context.js';
import { requireAnyPermission, requirePermission } from '../../middleware/authorization.js';
import { audit } from '../../utils/audit.js';
import { notFound } from '../../utils/errors.js';
import { likePattern, listQuerySchema, paginate } from '../../utils/pagination.js';
import { ok } from '../../utils/response.js';
import { API, type Deps } from '../deps.js';
import {
  assertActive,
  assertNotInUse,
  buildSet,
  codeSchema,
  descriptionSchema,
  idParams,
  nameSchema,
  optionalId,
  statusSchema,
  withTotal,
} from './shared.js';
import { courseDetailsSchema, subjectDetailsSchema, topicDetailsSchema } from './details.js';

const order = (o: string) => (o === 'desc' ? 'desc' : 'asc');

// ---------- courses ----------
const COURSE_COLUMNS = `c.id, c.code, c.name, c.description, c.status, c.details, c.academic_unit_id as "academicUnitId",
  u.name as "academicUnitName",
  (select count(*)::int from public.subjects s where s.organization_id = c.organization_id
     and s.course_id = c.id and s.deleted_at is null) as "subjectCount",
  c.created_at as "createdAt", c.updated_at as "updatedAt"`;
const COURSE_FROM = `public.courses c
  left join public.academic_units u on u.organization_id = c.organization_id and u.id = c.academic_unit_id`;
const COURSE_SORT: Record<string, string> = {
  code: 'c.code',
  name: 'c.name',
  createdAt: 'c.created_at',
};
const courseCreate = z
  .object({
    code: codeSchema,
    name: nameSchema,
    description: descriptionSchema.optional(),
    academicUnitId: z.uuid().nullable().optional(),
    details: courseDetailsSchema.optional(),
  })
  .strict();
const courseUpdate = z
  .object({
    code: codeSchema,
    name: nameSchema,
    description: descriptionSchema,
    academicUnitId: z.uuid().nullable(),
    status: statusSchema,
    details: courseDetailsSchema,
  })
  .partial()
  .strict();

// ---------- subjects ----------
const SUBJECT_COLUMNS = `s.id, s.code, s.name, s.description, s.status, s.details,
  s.course_id as "courseId", c.name as "courseName",
  s.academic_unit_id as "academicUnitId", u.name as "academicUnitName",
  (select count(*)::int from public.topics t where t.organization_id = s.organization_id
     and t.subject_id = s.id and t.deleted_at is null) as "topicCount",
  s.created_at as "createdAt", s.updated_at as "updatedAt"`;
const SUBJECT_FROM = `public.subjects s
  left join public.courses c on c.organization_id = s.organization_id and c.id = s.course_id
  left join public.academic_units u on u.organization_id = s.organization_id and u.id = s.academic_unit_id`;
const SUBJECT_SORT: Record<string, string> = {
  code: 's.code',
  name: 's.name',
  createdAt: 's.created_at',
};
const subjectCreate = z
  .object({
    code: codeSchema,
    name: nameSchema,
    description: descriptionSchema.optional(),
    courseId: z.uuid().nullable().optional(),
    academicUnitId: z.uuid().nullable().optional(),
    details: subjectDetailsSchema.optional(),
  })
  .strict();
const subjectUpdate = z
  .object({
    code: codeSchema,
    name: nameSchema,
    description: descriptionSchema,
    courseId: z.uuid().nullable(),
    academicUnitId: z.uuid().nullable(),
    status: statusSchema,
    details: subjectDetailsSchema,
  })
  .partial()
  .strict();

// ---------- topics ----------
const TOPIC_COLUMNS = `t.id, t.subject_id as "subjectId", s.name as "subjectName", t.name, t.position, t.details,
  t.created_at as "createdAt", t.updated_at as "updatedAt"`;
const TOPIC_FROM = `public.topics t
  join public.subjects s on s.organization_id = t.organization_id and s.id = t.subject_id`;
const TOPIC_SORT: Record<string, string> = {
  position: 't.position',
  name: 't.name',
  createdAt: 't.created_at',
};
const position = z.number().int().min(0).max(10000);
const topicCreate = z
  .object({
    subjectId: z.uuid(),
    name: nameSchema,
    position: position.optional(),
    details: topicDetailsSchema.optional(),
  })
  .strict();
const topicUpdate = z
  .object({ name: nameSchema, position, details: topicDetailsSchema })
  .partial()
  .strict();

async function getOne(db: Db, sql: string, org: string, id: string, label: string) {
  const r = await db.query(sql, [org, id]);
  if (!r.rows[0]) throw notFound(label);
  return r.rows[0] as Record<string, unknown>;
}
const getCourse = (db: Db, org: string, id: string) =>
  getOne(
    db,
    `select ${COURSE_COLUMNS} from ${COURSE_FROM} where c.organization_id = $1 and c.id = $2 and c.deleted_at is null`,
    org,
    id,
    'Course',
  );
const getSubject = (db: Db, org: string, id: string) =>
  getOne(
    db,
    `select ${SUBJECT_COLUMNS} from ${SUBJECT_FROM} where s.organization_id = $1 and s.id = $2 and s.deleted_at is null`,
    org,
    id,
    'Subject',
  );
const getTopic = (db: Db, org: string, id: string) =>
  getOne(
    db,
    `select ${TOPIC_COLUMNS} from ${TOPIC_FROM} where t.organization_id = $1 and t.id = $2 and t.deleted_at is null`,
    org,
    id,
    'Topic',
  );

export function registerAcademicCatalogRoutes(app: FastifyInstance, d: Deps): void {
  const org = (req: { ctx: { organization: { id: string } | null } }) => req.ctx.organization!.id;

  // ================= one-call tree for the Courses screen =================
  // Courses → subjects → topics with question counts, in one round trip (the database is far away; three paged lists
  // plus per-subject counts would take seconds). Runs as the caller, so RLS still limits what a teacher sees.
  app.get(
    `${API}/catalog/tree`,
    { preHandler: [d.authenticate, requireAnyPermission('course.read', 'subject.read')] },
    async (req) => {
      const LIMIT = 3000;
      const data = await withUser(d.pool, req.ctx.userId, async (db) => {
        const o = [org(req), LIMIT + 1];
        const courses = (
          await db.query(
            `select c.id, c.code, c.name, c.status from public.courses c
             where c.organization_id = $1 and c.deleted_at is null order by c.name, c.id limit $2`,
            o,
          )
        ).rows;
        const subjects = (
          await db.query(
            `select s.id, s.code, s.name, s.status, s.course_id as "courseId",
               (select count(*)::int from public.questions q where q.organization_id = s.organization_id
                  and q.subject_id = s.id and q.deleted_at is null) as "questionCount",
               (select json_build_object(
                  'published', count(*) filter (where q.status = 'published'),
                  'draft', count(*) filter (where q.status = 'draft'),
                  'easy', count(*) filter (where q.difficulty = 'easy'),
                  'medium', count(*) filter (where q.difficulty = 'medium'),
                  'hard', count(*) filter (where q.difficulty = 'hard'))
                from public.questions q where q.organization_id = s.organization_id
                  and q.subject_id = s.id and q.deleted_at is null) as "questionStats"
             from public.subjects s where s.organization_id = $1 and s.deleted_at is null
             order by s.name, s.id limit $2`,
            o,
          )
        ).rows;
        const topics = (
          await db.query(
            `select t.id, t.name, t.subject_id as "subjectId", t.position,
               (select count(*)::int from public.questions q where q.organization_id = t.organization_id
                  and q.topic_id = t.id and q.deleted_at is null) as "questionCount"
             from public.topics t where t.organization_id = $1 and t.deleted_at is null
             order by t.position, t.name, t.id limit $2`,
            o,
          )
        ).rows;
        const truncated = [courses, subjects, topics].some((r) => r.length > LIMIT);
        return {
          courses: courses.slice(0, LIMIT),
          subjects: subjects.slice(0, LIMIT),
          topics: topics.slice(0, LIMIT),
          truncated,
        };
      });
      return ok(data, req.id);
    },
  );

  // ================= courses =================
  app.get(
    `${API}/courses`,
    { preHandler: [d.authenticate, requirePermission('course.read')] },
    async (req) => {
      const q = listQuerySchema.parse(req.query);
      const f = z
        .object({ academicUnitId: optionalId, status: statusSchema.optional() })
        .parse(req.query);
      const params: unknown[] = [org(req)];
      const where = ['c.organization_id = $1', 'c.deleted_at is null'];
      if (f.academicUnitId) where.push(`c.academic_unit_id = $${params.push(f.academicUnitId)}`);
      if (f.status) where.push(`c.status = $${params.push(f.status)}`);
      if (q.search) {
        const p = params.push(likePattern(q.search));
        where.push(`(c.name ilike $${p} or c.code ilike $${p})`);
      }
      params.push(q.pageSize, (q.page - 1) * q.pageSize);
      const rows = await withUser(
        d.pool,
        req.ctx.userId,
        async (db) =>
          (
            await db.query(
              `select ${COURSE_COLUMNS}, count(*) over() as "__total" from ${COURSE_FROM}
               where ${where.join(' and ')}
               order by ${COURSE_SORT[q.sort ?? 'code'] ?? COURSE_SORT.code} ${order(q.order)}, c.id
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
    `${API}/courses/:id`,
    { preHandler: [d.authenticate, requirePermission('course.read')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      return ok(
        await withUser(d.pool, req.ctx.userId, (db) => getCourse(db, org(req), id)),
        req.id,
      );
    },
  );

  app.post(
    `${API}/courses`,
    { preHandler: [d.authenticate, requirePermission('course.create')] },
    async (req, reply) => {
      const body = courseCreate.parse(req.body);
      const course = await withUser(d.pool, req.ctx.userId, async (db) => {
        if (body.academicUnitId)
          await assertActive(db, 'academic_units', org(req), body.academicUnitId, 'Unit');
        const id = (
          await db.query(
            `insert into public.courses (organization_id, code, name, description, academic_unit_id, details)
             values ($1,$2,$3,$4,$5,$6) returning id`,
            [
              org(req),
              body.code,
              body.name,
              body.description ?? null,
              body.academicUnitId ?? null,
              body.details ?? {},
            ],
          )
        ).rows[0].id as string;
        return getCourse(db, org(req), id);
      });
      await audit(d.pool, req, 'COURSE_CREATED', 'courses', course.id as string);
      reply.code(201);
      return ok(course, req.id);
    },
  );

  app.patch(
    `${API}/courses/:id`,
    { preHandler: [d.authenticate, requirePermission('course.update')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const body = courseUpdate.parse(req.body);
      const { sets, vals } = buildSet(body, {
        code: 'code',
        name: 'name',
        description: 'description',
        academicUnitId: 'academic_unit_id',
        status: 'status',
        details: 'details',
      });
      const course = await withUser(d.pool, req.ctx.userId, async (db) => {
        if (body.academicUnitId)
          await assertActive(db, 'academic_units', org(req), body.academicUnitId, 'Unit');
        if (sets.length) {
          vals.push(req.ctx.userId, org(req), id);
          const n = vals.length;
          const r = await db.query(
            `update public.courses set ${sets.join(', ')}, updated_by = $${n - 2}
             where organization_id = $${n - 1} and id = $${n} and deleted_at is null`,
            vals,
          );
          if (!r.rowCount) throw notFound('Course');
        }
        return getCourse(db, org(req), id);
      });
      if (sets.length) await audit(d.pool, req, 'COURSE_UPDATED', 'courses', id, body);
      return ok(course, req.id);
    },
  );

  app.delete(
    `${API}/courses/:id`,
    { preHandler: [d.authenticate, requirePermission('course.delete')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      await assertNotInUse(
        d.pool,
        org(req),
        id,
        'COURSE_IN_USE',
        'Subjects still belong to this course. Move or delete them first.',
        { subjects: { table: 'subjects', column: 'course_id' } },
      );
      await withUser(d.pool, req.ctx.userId, async (db) => {
        const r = await db.query(
          `update public.courses set deleted_at = now(), updated_by = $1
           where organization_id = $2 and id = $3 and deleted_at is null`,
          [req.ctx.userId, org(req), id],
        );
        if (!r.rowCount) throw notFound('Course');
      });
      await audit(d.pool, req, 'COURSE_DELETED', 'courses', id);
      return ok({ deleted: true }, req.id);
    },
  );

  // ================= subjects =================
  app.get(
    `${API}/subjects`,
    { preHandler: [d.authenticate, requirePermission('subject.read')] },
    async (req) => {
      const q = listQuerySchema.parse(req.query);
      const f = z
        .object({
          courseId: optionalId,
          academicUnitId: optionalId,
          status: statusSchema.optional(),
        })
        .parse(req.query);
      const params: unknown[] = [org(req)];
      const where = ['s.organization_id = $1', 's.deleted_at is null'];
      if (f.courseId) where.push(`s.course_id = $${params.push(f.courseId)}`);
      if (f.academicUnitId) where.push(`s.academic_unit_id = $${params.push(f.academicUnitId)}`);
      if (f.status) where.push(`s.status = $${params.push(f.status)}`);
      if (q.search) {
        const p = params.push(likePattern(q.search));
        where.push(`(s.name ilike $${p} or s.code ilike $${p})`);
      }
      params.push(q.pageSize, (q.page - 1) * q.pageSize);
      const rows = await withUser(
        d.pool,
        req.ctx.userId,
        async (db) =>
          (
            await db.query(
              `select ${SUBJECT_COLUMNS}, count(*) over() as "__total" from ${SUBJECT_FROM}
               where ${where.join(' and ')}
               order by ${SUBJECT_SORT[q.sort ?? 'code'] ?? SUBJECT_SORT.code} ${order(q.order)}, s.id
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
    `${API}/subjects/:id`,
    { preHandler: [d.authenticate, requirePermission('subject.read')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      return ok(
        await withUser(d.pool, req.ctx.userId, (db) => getSubject(db, org(req), id)),
        req.id,
      );
    },
  );

  app.post(
    `${API}/subjects`,
    { preHandler: [d.authenticate, requirePermission('subject.create')] },
    async (req, reply) => {
      const body = subjectCreate.parse(req.body);
      const subject = await withUser(d.pool, req.ctx.userId, async (db) => {
        if (body.courseId) await assertActive(db, 'courses', org(req), body.courseId, 'Course');
        if (body.academicUnitId)
          await assertActive(db, 'academic_units', org(req), body.academicUnitId, 'Unit');
        const id = (
          await db.query(
            `insert into public.subjects (organization_id, code, name, description, course_id, academic_unit_id, details)
             values ($1,$2,$3,$4,$5,$6,$7) returning id`,
            [
              org(req),
              body.code,
              body.name,
              body.description ?? null,
              body.courseId ?? null,
              body.academicUnitId ?? null,
              body.details ?? {},
            ],
          )
        ).rows[0].id as string;
        return getSubject(db, org(req), id);
      });
      await audit(d.pool, req, 'SUBJECT_CREATED', 'subjects', subject.id as string);
      reply.code(201);
      return ok(subject, req.id);
    },
  );

  app.patch(
    `${API}/subjects/:id`,
    { preHandler: [d.authenticate, requirePermission('subject.update')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const body = subjectUpdate.parse(req.body);
      const { sets, vals } = buildSet(body, {
        code: 'code',
        name: 'name',
        description: 'description',
        courseId: 'course_id',
        academicUnitId: 'academic_unit_id',
        status: 'status',
        details: 'details',
      });
      const subject = await withUser(d.pool, req.ctx.userId, async (db) => {
        if (body.courseId) await assertActive(db, 'courses', org(req), body.courseId, 'Course');
        if (body.academicUnitId)
          await assertActive(db, 'academic_units', org(req), body.academicUnitId, 'Unit');
        if (sets.length) {
          vals.push(req.ctx.userId, org(req), id);
          const n = vals.length;
          const r = await db.query(
            `update public.subjects set ${sets.join(', ')}, updated_by = $${n - 2}
             where organization_id = $${n - 1} and id = $${n} and deleted_at is null`,
            vals,
          );
          if (!r.rowCount) throw notFound('Subject');
        }
        return getSubject(db, org(req), id);
      });
      if (sets.length) await audit(d.pool, req, 'SUBJECT_UPDATED', 'subjects', id, body);
      return ok(subject, req.id);
    },
  );

  app.delete(
    `${API}/subjects/:id`,
    { preHandler: [d.authenticate, requirePermission('subject.delete')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      await assertNotInUse(
        d.pool,
        org(req),
        id,
        'SUBJECT_IN_USE',
        'This subject still has topics or questions. Delete or move them first.',
        {
          topics: { table: 'topics', column: 'subject_id' },
          questions: { table: 'questions', column: 'subject_id' },
        },
      );
      await withUser(d.pool, req.ctx.userId, async (db) => {
        const r = await db.query(
          `update public.subjects set deleted_at = now(), updated_by = $1
           where organization_id = $2 and id = $3 and deleted_at is null`,
          [req.ctx.userId, org(req), id],
        );
        if (!r.rowCount) throw notFound('Subject');
      });
      await audit(d.pool, req, 'SUBJECT_DELETED', 'subjects', id);
      return ok({ deleted: true }, req.id);
    },
  );

  // ================= topics =================
  app.get(
    `${API}/topics`,
    { preHandler: [d.authenticate, requirePermission('topic.read')] },
    async (req) => {
      const q = listQuerySchema.parse(req.query);
      const f = z.object({ subjectId: optionalId }).parse(req.query);
      const params: unknown[] = [org(req)];
      const where = ['t.organization_id = $1', 't.deleted_at is null', 's.deleted_at is null'];
      if (f.subjectId) where.push(`t.subject_id = $${params.push(f.subjectId)}`);
      if (q.search) where.push(`t.name ilike $${params.push(likePattern(q.search))}`);
      params.push(q.pageSize, (q.page - 1) * q.pageSize);
      const rows = await withUser(
        d.pool,
        req.ctx.userId,
        async (db) =>
          (
            await db.query(
              `select ${TOPIC_COLUMNS}, count(*) over() as "__total" from ${TOPIC_FROM}
               where ${where.join(' and ')}
               order by ${TOPIC_SORT[q.sort ?? 'position'] ?? TOPIC_SORT.position} ${order(q.order)}, t.name, t.id
               limit $${params.length - 1} offset $${params.length}`,
              params,
            )
          ).rows,
      );
      const { items, total } = withTotal(rows);
      return ok(paginate(items, total, q), req.id);
    },
  );

  app.post(
    `${API}/topics`,
    { preHandler: [d.authenticate, requirePermission('topic.create')] },
    async (req, reply) => {
      const body = topicCreate.parse(req.body);
      const topic = await withUser(d.pool, req.ctx.userId, async (db) => {
        // 404 (not 403) for a subject outside the caller's scope: they cannot see it, so it does not exist for them.
        await assertActive(db, 'subjects', org(req), body.subjectId, 'Subject');
        const pos =
          body.position ??
          ((
            await db.query(
              `select coalesce(max(position), 0)::int + 1 as p from public.topics
               where organization_id = $1 and subject_id = $2 and deleted_at is null`,
              [org(req), body.subjectId],
            )
          ).rows[0].p as number);
        const id = (
          await db.query(
            `insert into public.topics (organization_id, subject_id, name, position, details)
             values ($1,$2,$3,$4,$5) returning id`,
            [org(req), body.subjectId, body.name, pos, body.details ?? {}],
          )
        ).rows[0].id as string;
        return getTopic(db, org(req), id);
      });
      await audit(d.pool, req, 'TOPIC_CREATED', 'topics', topic.id as string);
      reply.code(201);
      return ok(topic, req.id);
    },
  );

  app.patch(
    `${API}/topics/:id`,
    { preHandler: [d.authenticate, requirePermission('topic.update')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const body = topicUpdate.parse(req.body);
      const { sets, vals } = buildSet(body, {
        name: 'name',
        position: 'position',
        details: 'details',
      });
      const topic = await withUser(d.pool, req.ctx.userId, async (db) => {
        if (sets.length) {
          vals.push(req.ctx.userId, org(req), id);
          const n = vals.length;
          const r = await db.query(
            `update public.topics set ${sets.join(', ')}, updated_by = $${n - 2}
             where organization_id = $${n - 1} and id = $${n} and deleted_at is null`,
            vals,
          );
          if (!r.rowCount) throw notFound('Topic');
        }
        return getTopic(db, org(req), id);
      });
      if (sets.length) await audit(d.pool, req, 'TOPIC_UPDATED', 'topics', id, body);
      return ok(topic, req.id);
    },
  );

  app.delete(
    `${API}/topics/:id`,
    { preHandler: [d.authenticate, requirePermission('topic.delete')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      // Visibility first, so a teacher learns nothing about topics outside their scope.
      await withUser(d.pool, req.ctx.userId, (db) => getTopic(db, org(req), id));
      await assertNotInUse(
        d.pool,
        org(req),
        id,
        'TOPIC_IN_USE',
        'Questions still use this topic. Move or delete them first.',
        { questions: { table: 'questions', column: 'topic_id' } },
      );
      await withUser(d.pool, req.ctx.userId, async (db) => {
        const r = await db.query(
          `update public.topics set deleted_at = now(), updated_by = $1
           where organization_id = $2 and id = $3 and deleted_at is null`,
          [req.ctx.userId, org(req), id],
        );
        if (!r.rowCount) throw notFound('Topic');
      });
      await audit(d.pool, req, 'TOPIC_DELETED', 'topics', id);
      return ok({ deleted: true }, req.id);
    },
  );
}
