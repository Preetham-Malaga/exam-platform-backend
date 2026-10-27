// Phase 7: audit of the policies and privileges themselves. A change to any policy must change this file on purpose.
import { afterAll, describe, expect, it } from 'vitest';
import { DATABASE_TEST_URL, pool } from './helpers.js';

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows as T[];

// Commands each table's policies allow for signed-in users. ALL means select+insert+update+delete.
const EXPECTED: Record<string, string> = {
  academic_levels: 'DISU',
  academic_units: 'DISU',
  attempt_answers: 'S',
  audit_logs: 'S',
  courses: 'DISU',
  exam_assignments: 'DIS',
  exam_attempts: 'S',
  exam_questions: 'DISU',
  exam_settings: 'DISU',
  exams: 'DISU',
  files: 'ISU',
  leaderboards: 'S',
  notifications: 'SU',
  organization_members: 'SU',
  organization_settings: 'SU',
  organizations: 'SU',
  permissions: 'S',
  plan_limits: 'S',
  plans: 'S',
  profiles: 'SU',
  question_answer_keys: 'DISU',
  question_options: 'DISU',
  question_types: 'S',
  questions: 'DISU',
  results: 'S',
  role_permissions: 'S',
  roles: 'S',
  students: 'DISU',
  subjects: 'DISU',
  subscriptions: 'S',
  teachers: 'DISU',
  topics: 'DISU',
  user_roles: 'DIS',
  user_scopes: 'DIS',
};
const CATALOGUE = new Set([
  'permissions',
  'role_permissions',
  'question_types',
  'plans',
  'plan_limits',
]); // global read-only reference data

describe.skipIf(!DATABASE_TEST_URL)('policy and privilege audit (real PostgreSQL)', () => {
  afterAll(() => pool.end());

  const policies = () =>
    rows<{
      tablename: string;
      policyname: string;
      cmd: string;
      roles: string[];
      qual: string | null;
      with_check: string | null;
      permissive: string;
    }>(
      `select tablename, policyname, cmd, roles::text[] as roles, qual, with_check, permissive from pg_policies where schemaname = 'public'`,
    );

  it('every table has policies, and they allow exactly the commands in the design (nothing silently added)', async () => {
    const byTable = new Map<string, Set<string>>();
    for (const p of await policies()) {
      const set = byTable.get(p.tablename) ?? new Set<string>();
      const letters =
        p.cmd === 'ALL' ? 'SIUD' : { SELECT: 'S', INSERT: 'I', UPDATE: 'U', DELETE: 'D' }[p.cmd]!;
      for (const c of letters) set.add(c);
      byTable.set(p.tablename, set);
    }
    const actual = Object.fromEntries(
      [...byTable.entries()].map(([t, s]) => [t, [...s].sort().join('')]),
    );
    const expected = Object.fromEntries(
      Object.entries(EXPECTED).map(([t, s]) => [t, [...s].sort().join('')]),
    );
    expect(actual).toEqual(expected);
    const tables = (
      await rows<{ n: string }>(`select tablename as n from pg_tables where schemaname = 'public'`)
    )
      .map((r) => r.n)
      .sort();
    expect(Object.keys(EXPECTED).sort()).toEqual(tables); // a new table must get an entry (and policies) here
  });

  it('every policy is for signed-in users only (never PUBLIC or anon) and permissive', async () => {
    for (const p of await policies()) {
      expect(p.roles, `${p.tablename}.${p.policyname}`).toEqual(['authenticated']);
      expect(p.permissive, `${p.tablename}.${p.policyname}`).toBe('PERMISSIVE');
    }
  });

  it('tenant policies always involve the organization (no "using (true)" on tenant data)', async () => {
    const tenant = (
      await rows<{ n: string }>(
        `select table_name as n from information_schema.columns where table_schema = 'public' and column_name = 'organization_id'`,
      )
    ).map((r) => r.n);
    const weak: string[] = [];
    for (const p of await policies()) {
      if (CATALOGUE.has(p.tablename)) continue;
      const text = `${p.qual ?? ''} ${p.with_check ?? ''}`;
      if (/^\s*true\s*$/i.test(p.qual ?? '') || /^\s*true\s*$/i.test(p.with_check ?? ''))
        weak.push(`${p.tablename}.${p.policyname}: always true`);
      const isOwnRowOnly = p.tablename === 'profiles';
      if (tenant.includes(p.tablename) && !isOwnRowOnly && !/organization_id/.test(text))
        weak.push(`${p.tablename}.${p.policyname}: does not mention organization_id`);
      if (
        p.tablename === 'organizations' &&
        !/is_org_member\(id\)|has_permission\(id,|is_platform_admin/.test(text)
      )
        weak.push(`organizations.${p.policyname}`);
    }
    expect(weak).toEqual([]);
  });

  it('insert and update policies always have a check on the NEW row (a user cannot move a row elsewhere)', async () => {
    const bad: string[] = [];
    for (const p of await policies()) {
      if (['INSERT', 'ALL'].includes(p.cmd) && !p.with_check)
        bad.push(`${p.tablename}.${p.policyname}: INSERT without WITH CHECK`);
      if (p.cmd === 'UPDATE' && !p.with_check)
        bad.push(`${p.tablename}.${p.policyname}: UPDATE without WITH CHECK`);
    }
    expect(bad).toEqual([]);
  });

  it('table privileges: results, attempts, answers, leaderboards, audit logs, catalogues and billing can never be written by a user session', async () => {
    const readOnly = [
      'exam_attempts',
      'attempt_answers',
      'results',
      'leaderboards',
      'audit_logs',
      'permissions',
      'role_permissions',
      'question_types',
      'subscriptions',
      'plans',
      'plan_limits',
      'roles',
    ];
    for (const t of readOnly) {
      for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const r = await rows<{ ok: boolean }>(
          `select has_table_privilege('authenticated', $1, $2) as ok`,
          [`public.${t}`, priv],
        );
        expect(r[0]!.ok, `${t} ${priv}`).toBe(false);
      }
    }
    for (const t of Object.keys(EXPECTED)) {
      expect(
        (
          await rows<{ ok: boolean }>(
            `select has_table_privilege('authenticated', $1, 'TRUNCATE') as ok`,
            [`public.${t}`],
          )
        )[0]!.ok,
        `${t} TRUNCATE`,
      ).toBe(false);
      expect(
        (
          await rows<{ ok: boolean }>(`select has_table_privilege('anon', $1, 'SELECT') as ok`, [
            `public.${t}`,
          ])
        )[0]!.ok,
        `${t} anon`,
      ).toBe(false);
    }
  });

  it('no SECURITY DEFINER function lives in the public schema (public is exposed through the Supabase REST API)', async () => {
    const r = await rows<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef`,
    );
    expect(r).toEqual([]);
  });

  it('functions callable by signed-in users are exactly the helpers and the exam/leaderboard API; system functions are not', async () => {
    const callable = (
      await rows<{ n: string }>(
        `select p.proname as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
       where s.nspname = 'app' and has_function_privilege('authenticated', p.oid, 'execute') order by 1`,
      )
    ).map((r) => r.n);
    for (const fn of [
      'has_permission',
      'is_org_member',
      'in_scope',
      'start_attempt',
      'submit_attempt',
      'save_answer',
      'get_attempt',
      'leaderboard',
      'available_exams',
    ])
      expect(callable, fn).toContain(fn);
    for (const fn of [
      'register_organization',
      'add_member',
      'finalize_attempt',
      'expire_overdue_attempts',
      'activate_organization',
    ])
      expect(callable, fn).not.toContain(fn);
    const anon = (
      await rows<{ n: string }>(
        `select p.proname as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
       where s.nspname = 'app' and has_function_privilege('anon', p.oid, 'execute')`,
      )
    ).map((r) => r.n);
    expect(anon).toEqual([]);
  });

  it("only the documented tables allow users to read other people's rows through a global policy", async () => {
    const global = (await policies())
      .filter((p) => p.cmd === 'SELECT' && /^\s*true\s*$/i.test(p.qual ?? ''))
      .map((p) => p.tablename)
      .sort();
    expect(global).toEqual(
      [...CATALOGUE]
        .sort()
        .concat(['question_types'].filter(() => false))
        .sort(),
    );
  });
});
