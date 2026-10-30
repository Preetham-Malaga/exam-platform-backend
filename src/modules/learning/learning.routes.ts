// PURPOSE: Learning (prototype Live Classes, Recorded Classes, Materials): list, create, update, delete for
//          /live-classes, /recordings and /materials.
// WHY: Staff with learning.manage schedule classes and share videos and materials with a batch; students read the same
//      endpoints and RLS (migration 046) returns only items for their own batch. One table-driven module keeps the
//      three resources consistent. Files are links for now (Meet / Zoom, YouTube / Drive).
// DEPENDS ON: migration 046, academic/shared.ts helpers.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser, type Db } from '../../db/context.js';
import { requirePermission } from '../../middleware/authorization.js';
import { audit } from '../../utils/audit.js';
import { notFound } from '../../utils/errors.js';
import { ok } from '../../utils/response.js';
import { buildSet, idParams } from '../academic/shared.js';
import { API, type Deps } from '../deps.js';

const url = z
  .string()
  .trim()
  .url()
  .max(500)
  .regex(/^https?:\/\//, 'Use a full link starting with https://');
const txt = (max: number) => z.string().trim().max(max).nullable();
const ref = z.uuid().nullable();

/** Shared references: what the item is about and which batch sees it. */
const common = {
  title: z.string().trim().min(1).max(120),
  courseId: ref,
  subjectId: ref,
  topicId: ref,
  batchId: z.uuid(),
};

interface Resource {
  path: string;
  table: 'live_classes' | 'recordings' | 'materials';
  label: string;
  audit: string;
  schema: z.ZodObject<z.ZodRawShape>;
  columns: Record<string, string>;
  select: string;
  order: string;
}

const RESOURCES: Resource[] = [
  {
    path: 'live-classes',
    table: 'live_classes',
    label: 'Live class',
    audit: 'LIVE_CLASS',
    schema: z.object({
      ...common,
      teacherId: ref,
      agenda: txt(1000),
      startsAt: z.iso.datetime({ offset: true }),
      durationMinutes: z.number().int().min(5).max(600),
      platform: z.enum(['Zoom', 'Google Meet', 'Microsoft Teams', 'Other']),
      meetingLink: url,
      meetingId: txt(60),
      passcode: txt(60),
      willRecord: z.boolean(),
      status: z.enum(['scheduled', 'cancelled']),
    }),
    columns: {
      teacherId: 'teacher_id',
      agenda: 'agenda',
      startsAt: 'starts_at',
      durationMinutes: 'duration_minutes',
      platform: 'platform',
      meetingLink: 'meeting_link',
      meetingId: 'meeting_id',
      passcode: 'passcode',
      willRecord: 'will_record',
      status: 'status',
    },
    select: `x.teacher_id as "teacherId", t.full_name as "teacherName", x.agenda, x.starts_at as "startsAt",
      x.duration_minutes as "durationMinutes", x.platform, x.meeting_link as "meetingLink", x.meeting_id as "meetingId",
      x.passcode, x.will_record as "willRecord", x.status,
      exists (select 1 from public.recordings r where r.organization_id = x.organization_id and r.live_class_id = x.id
        and r.deleted_at is null) as "hasRecording"`,
    order: 'x.starts_at',
  },
  {
    path: 'recordings',
    table: 'recordings',
    label: 'Recording',
    audit: 'RECORDING',
    schema: z.object({
      ...common,
      teacherId: ref,
      source: z.enum(['YouTube', 'Vimeo', 'Google Drive', 'Other link']),
      videoUrl: url,
      duration: txt(20),
      liveClassId: ref,
      description: txt(2000),
      availableFrom: z.iso.date().nullable(),
      availableUntil: z.iso.date().nullable(),
      allowDownload: z.boolean(),
      status: z.enum(['draft', 'published']),
    }),
    columns: {
      teacherId: 'teacher_id',
      source: 'source',
      videoUrl: 'video_url',
      duration: 'duration',
      liveClassId: 'live_class_id',
      description: 'description',
      availableFrom: 'available_from',
      availableUntil: 'available_until',
      allowDownload: 'allow_download',
      status: 'status',
    },
    select: `x.teacher_id as "teacherId", t.full_name as "teacherName", x.source, x.video_url as "videoUrl", x.duration,
      x.live_class_id as "liveClassId", x.description, to_char(x.available_from, 'YYYY-MM-DD') as "availableFrom",
      to_char(x.available_until, 'YYYY-MM-DD') as "availableUntil", x.allow_download as "allowDownload", x.status`,
    order: 'x.created_at desc',
  },
  {
    path: 'materials',
    table: 'materials',
    label: 'Material',
    audit: 'MATERIAL',
    schema: z.object({
      ...common,
      materialType: z.enum([
        'Notes',
        'Slides',
        'Question paper',
        'Assignment',
        'Syllabus',
        'Reference',
        'Other',
      ]),
      linkUrl: url,
      description: txt(1000),
      availableFrom: z.iso.date().nullable(),
      allowDownload: z.boolean(),
      status: z.enum(['draft', 'published']),
    }),
    columns: {
      materialType: 'material_type',
      linkUrl: 'link_url',
      description: 'description',
      availableFrom: 'available_from',
      allowDownload: 'allow_download',
      status: 'status',
    },
    select: `x.material_type as "materialType", x.link_url as "linkUrl", x.description,
      to_char(x.available_from, 'YYYY-MM-DD') as "availableFrom", x.allow_download as "allowDownload", x.status`,
    order: 'x.created_at desc',
  },
];

const COMMON_COLUMNS = {
  title: 'title',
  courseId: 'course_id',
  subjectId: 'subject_id',
  topicId: 'topic_id',
  batchId: 'batch_id',
};

function sqlFor(r: Resource) {
  const teacherJoin =
    r.table === 'materials'
      ? ''
      : 'left join public.teachers t on t.organization_id = x.organization_id and t.id = x.teacher_id';
  return {
    select: `select x.id, x.title, x.course_id as "courseId", c.name as "courseName", x.subject_id as "subjectId",
      s.name as "subjectName", x.topic_id as "topicId", x.batch_id as "batchId", b.name as "batchName",
      ${r.select}, x.created_at as "createdAt", x.updated_at as "updatedAt"
      from public.${r.table} x
      left join public.courses c on c.organization_id = x.organization_id and c.id = x.course_id
      left join public.subjects s on s.organization_id = x.organization_id and s.id = x.subject_id
      left join public.batches b on b.organization_id = x.organization_id and b.id = x.batch_id
      ${teacherJoin}`,
  };
}

async function getOne(db: Db, r: Resource, org: string, id: string) {
  const row = (
    await db.query(
      `${sqlFor(r).select} where x.organization_id = $1 and x.id = $2 and x.deleted_at is null`,
      [org, id],
    )
  ).rows[0];
  if (!row) throw notFound(r.label);
  return row as Record<string, unknown>;
}

export function registerLearningRoutes(app: FastifyInstance, d: Deps): void {
  const org = (req: { ctx: { organization: { id: string } | null } }) => req.ctx.organization!.id;

  for (const r of RESOURCES) {
    const all = { ...COMMON_COLUMNS, ...r.columns };
    const create = r.schema.partial().required({ title: true, batchId: true }).strict();
    const update = r.schema.partial().strict();

    app.get(
      `${API}/${r.path}`,
      { preHandler: [d.authenticate, requirePermission('learning.read')] },
      async (req) => {
        const f = z
          .object({
            batchId: z.uuid().optional(),
            subjectId: z.uuid().optional(),
            /** live classes only: today, upcoming or past (in the organization's time zone). */
            when: z.enum(['today', 'upcoming', 'past']).optional(),
          })
          .parse(req.query);
        const params: unknown[] = [org(req)];
        const where = ['x.organization_id = $1', 'x.deleted_at is null'];
        if (f.batchId) where.push(`x.batch_id = $${params.push(f.batchId)}`);
        if (f.subjectId) where.push(`x.subject_id = $${params.push(f.subjectId)}`);
        let order = r.order;
        if (r.table === 'live_classes' && f.when) {
          const tz = `coalesce((select timezone from public.organization_settings where organization_id = $1), 'Asia/Kolkata')`;
          const day = `(x.starts_at at time zone ${tz})::date`;
          const today = `(now() at time zone ${tz})::date`;
          if (f.when === 'today') where.push(`${day} = ${today}`);
          if (f.when === 'upcoming') where.push(`x.starts_at > now()`);
          if (f.when === 'past') {
            where.push(`x.starts_at + make_interval(mins => x.duration_minutes) < now()`);
            order = 'x.starts_at desc';
          }
        }
        const items = await withUser(
          d.pool,
          req.ctx.userId,
          async (db) =>
            (
              await db.query(
                `${sqlFor(r).select} where ${where.join(' and ')} order by ${order}, x.id limit 500`,
                params,
              )
            ).rows,
        );
        return ok({ items }, req.id);
      },
    );

    app.post(
      `${API}/${r.path}`,
      { preHandler: [d.authenticate, requirePermission('learning.manage')] },
      async (req, reply) => {
        const body = create.parse(req.body);
        const { sets, vals } = buildSet(body, all);
        const item = await withUser(d.pool, req.ctx.userId, async (db) => {
          const cols = sets.map((s) => s.split(' = ')[0]);
          vals.push(org(req));
          const id = (
            await db.query(
              `insert into public.${r.table} (${cols.join(', ')}, organization_id)
               values (${vals.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
              vals,
            )
          ).rows[0].id as string;
          return getOne(db, r, org(req), id);
        });
        await audit(d.pool, req, `${r.audit}_CREATED`, r.table, item.id as string);
        reply.code(201);
        return ok(item, req.id);
      },
    );

    app.patch(
      `${API}/${r.path}/:id`,
      { preHandler: [d.authenticate, requirePermission('learning.manage')] },
      async (req) => {
        const { id } = idParams.parse(req.params);
        const body = update.parse(req.body);
        const { sets, vals } = buildSet(body, all);
        const item = await withUser(d.pool, req.ctx.userId, async (db) => {
          if (sets.length) {
            vals.push(req.ctx.userId, org(req), id);
            const n = vals.length;
            const res = await db.query(
              `update public.${r.table} set ${sets.join(', ')}, updated_by = $${n - 2}
               where organization_id = $${n - 1} and id = $${n} and deleted_at is null`,
              vals,
            );
            if (!res.rowCount) throw notFound(r.label);
          }
          return getOne(db, r, org(req), id);
        });
        if (sets.length) await audit(d.pool, req, `${r.audit}_UPDATED`, r.table, id);
        return ok(item, req.id);
      },
    );

    app.delete(
      `${API}/${r.path}/:id`,
      { preHandler: [d.authenticate, requirePermission('learning.manage')] },
      async (req) => {
        const { id } = idParams.parse(req.params);
        await withUser(d.pool, req.ctx.userId, async (db) => {
          const res = await db.query(
            `update public.${r.table} set deleted_at = now(), updated_by = $1
             where organization_id = $2 and id = $3 and deleted_at is null`,
            [req.ctx.userId, org(req), id],
          );
          if (!res.rowCount) throw notFound(r.label);
        });
        await audit(d.pool, req, `${r.audit}_DELETED`, r.table, id);
        return ok({ deleted: true }, req.id);
      },
    );
  }
}
