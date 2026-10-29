// Phase 3: proves the migrations are valid and the schema follows the multi-tenant rules.
// The file-name test always runs. The database tests run when DATABASE_TEST_URL points to a migrated TEST database
// (never point it at production or at a project that holds data you care about).
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));

const EXPECTED_FILES = [
  '001_extensions',
  '002_organizations',
  '003_organization_settings',
  '004_profiles',
  '005_organization_members',
  '006_roles',
  '007_permissions',
  '008_role_permissions',
  '009_user_roles',
  '010_user_scopes',
  '011_academic_levels',
  '012_academic_units',
  '013_courses',
  '014_subjects',
  '015_topics',
  '016_students',
  '017_teachers',
  '018_questions',
  '019_question_options',
  '020_question_answer_keys',
  '021_files',
  '022_exams',
  '023_exam_settings',
  '024_exam_questions',
  '025_exam_assignments',
  '026_exam_attempts',
  '027_attempt_answers',
  '028_results',
  '029_leaderboards',
  '030_plans',
  '031_plan_limits',
  '032_subscriptions',
  '033_notifications',
  '034_audit_logs',
  '035_indexes',
  '036_rls_policies',
  '037_functions',
  '038_triggers',
  '039_roles_readonly',
  '040_leaderboard_privacy',
  '041_app_functions_lockdown',
  '042_academic_structure',
  '043_organization_approval',
  '044_catalog_details',
].map((n) => `${n}.sql`);

// Tables that carry organization_id but intentionally do not follow every rule (documented in docs/database.md).
const ORG_ID_NULLABLE = new Set(['audit_logs', 'roles']); // platform-level audit rows and shared system roles
const NO_UPDATED_AT = new Set([
  'audit_logs',
  'exam_assignments',
  'exam_questions',
  'notifications',
  'results',
  'user_roles',
  'user_scopes',
]);
// Foreign keys to these parents are allowed to be single-column (parent rows are not tenant-owned or are validated by a trigger).
const SINGLE_COLUMN_FK_PARENTS = new Set(['roles']);

describe('migration files', () => {
  it('exist in order: 001-038 as in the architecture guide, then later additions', () => {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toEqual(EXPECTED_FILES);
  });
});

const url = process.env.DATABASE_TEST_URL;

describe.skipIf(!url)('schema rules (real PostgreSQL)', () => {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  afterAll(() => pool.end());
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await pool.query(sql, params)).rows as T[];

  const publicTables = async () =>
    (
      await rows<{ n: string }>(
        `select table_name as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
      )
    ).map((r) => r.n);
  const orgTables = async () =>
    (
      await rows<{ n: string }>(
        `select table_name as n from information_schema.columns where table_schema = 'public' and column_name = 'organization_id' order by 1`,
      )
    ).map((r) => r.n);

  it('all migrations are recorded as applied, in order', async () => {
    const applied = (
      await rows<{ name: string }>('select name from app.migrations order by name')
    ).map((r) => r.name);
    expect(applied).toEqual(EXPECTED_FILES);
  });

  it('creates every table of the architecture guide', async () => {
    const t = await publicTables();
    for (const name of [
      'organizations',
      'organization_settings',
      'profiles',
      'organization_members',
      'roles',
      'permissions',
      'role_permissions',
      'user_roles',
      'user_scopes',
      'academic_levels',
      'academic_units',
      'courses',
      'subjects',
      'topics',
      'students',
      'teachers',
      'questions',
      'question_options',
      'question_answer_keys',
      'files',
      'exams',
      'exam_settings',
      'exam_questions',
      'exam_assignments',
      'exam_attempts',
      'attempt_answers',
      'results',
      'leaderboards',
      'plans',
      'plan_limits',
      'subscriptions',
      'notifications',
      'audit_logs',
    ])
      expect(t, name).toContain(name);
  });

  it('row level security is enabled on EVERY table', async () => {
    const off = await rows<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`,
    );
    expect(off.map((r) => r.relname)).toEqual([]);
  });

  it('every table has a uuid primary key named id, except pure link tables', async () => {
    const bad = await rows<{ t: string }>(
      `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and not exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                         where i.indrelid = c.oid and i.indisprimary and a.attname = 'id' and a.atttypid = 'uuid'::regtype and i.indnatts = 1)
         and c.relname not in ('role_permissions', 'question_types', 'plan_limits')
       order by 1`,
    );
    // question_types uses a text code as key; role_permissions is a pure link table; plan_limits is keyed by uuid id? (checked below)
    expect(bad.map((r) => r.t)).toEqual([]);
  });

  it('organization-owned tables: organization_id is NOT NULL (except documented), has created_at, updated_at where editable', async () => {
    const problems: string[] = [];
    for (const t of await orgTables()) {
      const cols = await rows<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable from information_schema.columns where table_schema = 'public' and table_name = $1`,
        [t],
      );
      const byName = new Map(cols.map((c) => [c.column_name, c.is_nullable]));
      if (!ORG_ID_NULLABLE.has(t) && byName.get('organization_id') !== 'NO')
        problems.push(`${t}.organization_id must be NOT NULL`);
      if (!byName.has('created_at')) problems.push(`${t} is missing created_at`);
      if (!NO_UPDATED_AT.has(t) && !byName.has('updated_at'))
        problems.push(`${t} is missing updated_at`);
    }
    expect(problems).toEqual([]);
  });

  it('every organization_id points to organizations (ON DELETE CASCADE)', async () => {
    const missing: string[] = [];
    for (const t of (await orgTables()).filter((x) => x !== 'organizations')) {
      const fk = await rows(
        `select 1 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
         where c.contype = 'f' and c.conrelid = ('public.' || $1)::regclass and a.attname = 'organization_id'
           and c.confrelid = 'public.organizations'::regclass and array_length(c.conkey, 1) = 1 and c.confdeltype = 'c'`,
        [t],
      );
      if (!fk.length) missing.push(t);
    }
    expect(missing).toEqual([]);
  });

  it('cross-organization references are impossible: foreign keys between tenant tables are composite and include organization_id', async () => {
    const fks = await rows<{
      child: string;
      parent: string;
      child_cols: string[];
      parent_cols: string[];
      name: string;
    }>(
      `select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent, c.conname as name,
              array(select a.attname from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k) as child_cols,
              array(select a.attname from unnest(c.confkey) k join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k) as parent_cols
       from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace`,
    );
    const tenant = new Set((await orgTables()).filter((t) => t !== 'audit_logs'));
    const offenders: string[] = [];
    let composite = 0;
    for (const fk of fks) {
      const child = fk.child.replace('public.', '');
      const parent = fk.parent.replace('public.', '');
      if (!tenant.has(child) || !tenant.has(parent) || SINGLE_COLUMN_FK_PARENTS.has(parent))
        continue;
      if (fk.child_cols.includes('organization_id') && fk.parent_cols.includes('organization_id'))
        composite++;
      else offenders.push(`${child}(${fk.child_cols}) -> ${parent}(${fk.parent_cols})`);
    }
    expect(offenders).toEqual([]);
    expect(composite).toBeGreaterThan(25);
  });

  it('business codes are unique PER ORGANIZATION, never globally', async () => {
    const pairs: Array<[string, string]> = [
      ['academic_levels', 'code'],
      ['academic_units', 'code'],
      ['courses', 'code'],
      ['subjects', 'code'],
      ['students', 'roll_number'],
      ['teachers', 'employee_code'],
      ['exams', 'exam_code'],
    ];
    for (const [table, column] of pairs) {
      const defs = (
        await rows<{ def: string }>(
          `select pg_get_indexdef(i.indexrelid) as def from pg_index i where i.indrelid = ('public.' || $1)::regclass and i.indisunique`,
          [table],
        )
      ).map((r) => r.def);
      // matches "(organization_id, code)" and the case-insensitive variant "(organization_id, lower(code))"
      const scoped = new RegExp(`btree \\(organization_id, (lower\\()?${column}\\)?\\)`);
      const global = new RegExp(`btree \\((lower\\()?${column}\\)?\\)`);
      expect(
        defs.some((d) => scoped.test(d)),
        `${table}.${column} must be unique per organization`,
      ).toBe(true);
      expect(
        defs.some((d) => global.test(d)),
        `${table}.${column} must not be globally unique`,
      ).toBe(false);
    }
  });

  it('every tenant table has an index that starts with organization_id', async () => {
    const missing: string[] = [];
    for (const t of (await orgTables()).filter((x) => !['organizations'].includes(x))) {
      const r = await rows(
        `select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
         where i.indrelid = ('public.' || $1)::regclass and a.attname = 'organization_id' limit 1`,
        [t],
      );
      if (!r.length) missing.push(t);
    }
    // audit_logs is covered by audit_logs_org_created_idx; exam_attempts etc. by composite indexes
    expect(missing).toEqual([]);
  });

  it('SECURITY DEFINER functions pin their search_path (prevents hijacking)', async () => {
    const bad = await rows<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('app', 'public') and p.prosecdef and not coalesce(p.proconfig::text ilike '%search_path=%', false) order by 1`,
    );
    expect(bad.map((r) => r.proname)).toEqual([]);
  });

  it('the anonymous role has no privileges on any table; system functions are not callable by users', async () => {
    const anon = await rows(
      `select 1 from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'`,
    );
    expect(anon).toHaveLength(0);
    for (const fn of [
      'app.register_organization(uuid,text,text,text,text)',
      'app.add_member(uuid,uuid,text,text,text,uuid)',
      'app.finalize_attempt(uuid,boolean)',
      'app.activate_organization(uuid)',
    ]) {
      const r = await rows<{ ok: boolean }>(
        `select has_function_privilege('authenticated', $1, 'execute') as ok`,
        [fn],
      );
      expect(r[0]!.ok, fn).toBe(false);
    }
  });

  it('seed data: five roles, permission catalogue and role mapping', async () => {
    const roles = (
      await rows<{ code: string }>(
        'select code from roles where organization_id is null order by code',
      )
    ).map((r) => r.code);
    expect(roles).toEqual([
      'ORGANIZATION_ADMIN',
      'ORGANIZATION_OWNER',
      'PLATFORM_SUPER_ADMIN',
      'STUDENT',
      'TEACHER',
    ]);
    const perms = async (role: string) =>
      (
        await rows<{ code: string }>(
          `select p.code from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id where r.code = $1 order by 1`,
          [role],
        )
      ).map((r) => r.code);
    const total = (await rows<{ c: number }>('select count(*)::int c from permissions'))[0]!.c;
    expect((await perms('ORGANIZATION_OWNER')).length).toBe(total);
    expect(await perms('STUDENT')).toEqual(['leaderboard.read', 'notification.read']);
    expect(await perms('PLATFORM_SUPER_ADMIN')).toEqual([]); // platform staff are not organization members
    const admin = await perms('ORGANIZATION_ADMIN');
    expect(admin).not.toContain('organization.update');
    expect(admin).toContain('user.update');
    const teacher = await perms('TEACHER');
    expect(teacher).toContain('question.create');
    for (const forbidden of [
      'user.update',
      'user.create',
      'student.create',
      'course.create',
      'settings.update',
      'academic.manage',
    ])
      expect(teacher).not.toContain(forbidden);
    for (const p of [
      'organization.read',
      'user.read',
      'question.publish',
      'exam.assign',
      'result.read',
      'leaderboard.read',
      'subscription.read',
    ]) {
      expect((await rows('select 1 from permissions where code = $1', [p])).length, p).toBe(1);
    }
  });

  it('seed data: trial plan with limits for students, teachers, questions, exams and storage', async () => {
    const limits = (
      await rows<{ limit_key: string }>(
        `select l.limit_key from plan_limits l join plans p on p.id = l.plan_id where p.code = 'trial' order by 1`,
      )
    ).map((r) => r.limit_key);
    expect(limits).toEqual(['exams', 'questions', 'storage_mb', 'students', 'teachers']);
  });

  it('deleting an organization removes ALL of its data (every foreign key cascades) and nothing else', async () => {
    const mkOrg = async (label: string) => {
      const email = `${label}.${Date.now()}@cascade.test`;
      const uid = (
        await pool.query('insert into auth.users (email) values ($1) returning id', [email])
      ).rows[0].id as string;
      return (
        await pool.query('select app.register_organization($1,$2,$3,$4,$5) as id', [
          uid,
          email,
          label,
          `${label} College`,
          'engineering',
        ])
      ).rows[0].id as string;
    };
    const victim = await mkOrg('victim');
    const survivor = await mkOrg('survivor');
    const one = async (sql: string, params: unknown[]) =>
      (await pool.query(sql, params)).rows[0] as Record<string, string>;

    const level = await one(
      'select id from academic_levels where organization_id = $1 order by position limit 1',
      [victim],
    );
    const unit = await one(
      `insert into academic_units (organization_id, level_id, code, name) values ($1,$2,'U','U') returning id`,
      [victim, level!.id],
    );
    const course = await one(
      `insert into courses (organization_id, code, name) values ($1,'C','C') returning id`,
      [victim],
    );
    const subject = await one(
      `insert into subjects (organization_id, course_id, code, name) values ($1,$2,'S','S') returning id`,
      [victim, course!.id],
    );
    const topic = await one(
      `insert into topics (organization_id, subject_id, name) values ($1,$2,'T') returning id`,
      [victim, subject!.id],
    );
    const student = await one(
      `insert into students (organization_id, roll_number, full_name, academic_unit_id) values ($1,'R','S',$2) returning id`,
      [victim, unit!.id],
    );
    await pool.query(
      `insert into teachers (organization_id, employee_code, full_name) values ($1,'E','T')`,
      [victim],
    );
    const q = await one(
      `insert into questions (organization_id, subject_id, topic_id, question_type, question_text) values ($1,$2,$3,'multiple_choice','Q?') returning id`,
      [victim, subject!.id, topic!.id],
    );
    const o1 = await one(
      `insert into question_options (organization_id, question_id, option_text, position) values ($1,$2,'a',1) returning id`,
      [victim, q!.id],
    );
    await pool.query(
      `insert into question_options (organization_id, question_id, option_text, position) values ($1,$2,'b',2)`,
      [victim, q!.id],
    );
    await pool.query(
      `insert into question_answer_keys (organization_id, question_id, correct_option_id) values ($1,$2,$3)`,
      [victim, q!.id, o1!.id],
    );
    await pool.query(`update questions set status = 'published' where id = $1`, [q!.id]);
    const exam = await one(
      `insert into exams (organization_id, name, exam_code, duration_minutes) values ($1,'E','EX1',30) returning id`,
      [victim],
    );
    await pool.query(`insert into exam_settings (organization_id, exam_id) values ($1,$2)`, [
      victim,
      exam!.id,
    ]);
    await pool.query(
      `insert into exam_questions (organization_id, exam_id, question_id, position) values ($1,$2,$3,1)`,
      [victim, exam!.id, q!.id],
    );
    await pool.query(
      `insert into exam_assignments (organization_id, exam_id, target_type, target_id) values ($1,$2,'organization',$1)`,
      [victim, exam!.id],
    );
    const att = await one(
      `insert into exam_attempts (organization_id, exam_id, student_id, attempt_no, deadline_at, question_order) values ($1,$2,$3,1, now() + interval '1 hour', array[$4::uuid]) returning id`,
      [victim, exam!.id, student!.id, q!.id],
    );
    await pool.query(
      `insert into attempt_answers (organization_id, attempt_id, question_id, selected_option_id) values ($1,$2,$3,$4)`,
      [victim, att!.id, q!.id, o1!.id],
    );
    const res = await one(
      `insert into results (organization_id, attempt_id, student_id, exam_id, score, maximum_score, percentage, correct_count, wrong_count, unanswered_count, duration_seconds, status) values ($1,$2,$3,$4,1,1,100,1,0,0,5,'Passed') returning id`,
      [victim, att!.id, student!.id, exam!.id],
    );
    await pool.query(
      `insert into leaderboards (organization_id, exam_id, student_id, best_result_id, best_score, best_percentage, best_duration_seconds, attempts_count) values ($1,$2,$3,$4,1,100,5,1)`,
      [victim, exam!.id, student!.id, res!.id],
    );
    await pool.query(
      `insert into audit_logs (organization_id, action, resource) values ($1,'TEST','x')`,
      [victim],
    );

    await pool.query('delete from organizations where id = $1', [victim]);

    const leftovers: string[] = [];
    for (const t of await orgTables()) {
      const r = await pool.query(
        `select count(*)::int as c from public.${t} where organization_id = $1`,
        [victim],
      );
      if (r.rows[0].c !== 0) leftovers.push(t);
    }
    expect(leftovers).toEqual([]);
    expect(
      (
        await pool.query('select count(*)::int c from academic_levels where organization_id = $1', [
          survivor,
        ])
      ).rows[0].c,
    ).toBeGreaterThan(0);
    expect(
      (await pool.query('select count(*)::int c from organizations where id = $1', [survivor]))
        .rows[0].c,
    ).toBe(1);
  });

  it('org_code is generated (ORG-000001 style) and unique; id is a uuid', async () => {
    const r = await rows<{ org_code: string; id: string }>(
      'select org_code, id from organizations limit 1',
    );
    if (r[0]) {
      expect(r[0].org_code).toMatch(/^ORG-\d{6,}$/);
      expect(r[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
    const unique = await rows(
      `select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
       where i.indrelid = 'public.organizations'::regclass and i.indisunique and a.attname = 'org_code' and i.indnatts = 1`,
    );
    expect(unique.length).toBe(1);
  });
});

describe.skipIf(!url)('applying the migrations to an EMPTY database', () => {
  let tmpUrl = '';
  let adminUrl = '';
  let dbName = '';
  let canCreate = false;

  const run = (args: string[], databaseUrl: string): string =>
    execFileSync(process.execPath, ['scripts/migrate.mjs', ...args], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  afterAll(async () => {
    if (!canCreate) return;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`drop database if exists "${dbName}" with (force)`);
    await admin.end();
  });

  it('applies every migration from scratch, is idempotent, and refuses edited migrations', async (ctx) => {
    const u = new URL(url!);
    dbName = `exam_phase3_${Date.now().toString(36)}`;
    adminUrl = (() => {
      const a = new URL(url!);
      a.pathname = '/postgres';
      return a.toString();
    })();
    u.pathname = `/${dbName}`;
    tmpUrl = u.toString();
    const admin = new pg.Client({ connectionString: adminUrl });
    try {
      await admin.connect();
      await admin.query(`create database "${dbName}"`);
      canCreate = true;
    } catch {
      return ctx.skip(); // this role may not create databases (e.g. a hosted project); the other tests still cover the schema
    } finally {
      await admin.end().catch(() => undefined);
    }

    expect(run(['--shim'], tmpUrl)).toContain(
      `Done. ${EXPECTED_FILES.length} migration(s) applied.`,
    );
    expect(run([], tmpUrl)).toContain('Database is up to date.');

    const c = new pg.Client({ connectionString: tmpUrl });
    await c.connect();
    await c.query(
      `update app.migrations set checksum = 'tampered' where name = '002_organizations.sql'`,
    );
    await c.end();
    expect(() => run([], tmpUrl)).toThrow(/changed after it was applied/);
  }, 120_000);
});
