// Phase 6 (database level): roles, permissions and who may change them.
import { afterAll, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../src/auth/permissions.js';
import {
  DATABASE_TEST_URL,
  asUser,
  createTenant,
  createUser,
  expectDenied,
  pool,
} from './helpers.js';

describe.skipIf(!DATABASE_TEST_URL)('RBAC (real PostgreSQL)', () => {
  afterAll(() => pool.end());

  it('the typed permission list in the code equals the permissions seeded in the database', async () => {
    const db = (await pool.query('select code from permissions order by code')).rows.map(
      (r) => r.code as string,
    );
    expect([...PERMISSIONS].sort()).toEqual(db);
  });

  it('app.has_permission gives every role exactly the permissions the role mapping defines (full matrix)', async () => {
    const T = await createTenant('matrix');
    const roleUser: Record<string, string> = {
      ORGANIZATION_OWNER: T.owner,
      ORGANIZATION_ADMIN: T.admin,
      TEACHER: T.teacher1,
      STUDENT: T.student,
    };
    const mapping = await pool.query(
      `select r.code as role, array_agg(p.code) as perms from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id group by r.code`,
    );
    const wanted = new Map<string, Set<string>>(
      mapping.rows.map((r) => [r.role as string, new Set<string>(r.perms as string[])]),
    );
    const wrong: string[] = [];
    for (const [role, user] of Object.entries(roleUser)) {
      for (const p of PERMISSIONS) {
        const got = (
          await asUser<{ ok: boolean }>(user, 'select app.has_permission($1, $2) as ok', [
            T.orgId,
            p,
          ])
        )[0]!.ok;
        if (got !== wanted.get(role)!.has(p)) wrong.push(`${role} ${p}: got ${got}`);
      }
    }
    expect(wrong).toEqual([]);
    // spot checks that document the intent
    expect(wanted.get('TEACHER')!.has('user.update')).toBe(false);
    expect(wanted.get('STUDENT')!.size).toBe(2);
    expect(wanted.get('ORGANIZATION_ADMIN')!.has('organization.update')).toBe(false);
    expect(wanted.get('ORGANIZATION_OWNER')!.size).toBe(PERMISSIONS.length);
  });

  it('permissions never cross organizations (a role in College A grants nothing in College B)', async () => {
    const A = await createTenant('rbacA');
    const B = await createTenant('rbacB');
    for (const p of ['organization.read', 'student.read', 'exam.create', 'user.update']) {
      expect(
        (
          await asUser<{ ok: boolean }>(A.owner, 'select app.has_permission($1, $2) as ok', [
            B.orgId,
            p,
          ])
        )[0]!.ok,
        p,
      ).toBe(false);
      expect(
        (
          await asUser<{ ok: boolean }>(A.owner, 'select app.has_role($1, $2) as ok', [
            B.orgId,
            'ORGANIZATION_OWNER',
          ])
        )[0]!.ok,
      ).toBe(false);
    }
    expect(
      (await asUser<{ ok: boolean }>(A.owner, 'select app.is_org_member($1) as ok', [B.orgId]))[0]!
        .ok,
    ).toBe(false);
  });

  it('a user holding two roles gets the union of both; removing a role removes exactly its permissions', async () => {
    const T = await createTenant('union');
    const ok = async (p: string) =>
      (
        await asUser<{ ok: boolean }>(T.student, 'select app.has_permission($1, $2) as ok', [
          T.orgId,
          p,
        ])
      )[0]!.ok;
    expect(await ok('question.create')).toBe(false);
    await pool.query(
      `insert into user_roles (organization_id, user_id, role_id) select $1, $2, id from roles where code = 'TEACHER'`,
      [T.orgId, T.student],
    );
    expect(await ok('question.create')).toBe(true);
    expect(await ok('leaderboard.read')).toBe(true); // still a student too
    await pool.query(
      `delete from user_roles ur using roles r where r.id = ur.role_id and r.code = 'TEACHER' and ur.user_id = $1`,
      [T.student],
    );
    expect(await ok('question.create')).toBe(false);
    expect(await ok('leaderboard.read')).toBe(true);
  });

  it('suspending a membership removes every permission at once; reactivating restores them', async () => {
    const T = await createTenant('suspendmember');
    const ok = async () =>
      (
        await asUser<{ ok: boolean }>(
          T.teacher1,
          `select app.has_permission($1, 'question.read') as ok`,
          [T.orgId],
        )
      )[0]!.ok;
    expect(await ok()).toBe(true);
    await pool.query(
      `update organization_members set status = 'suspended' where organization_id = $1 and user_id = $2`,
      [T.orgId, T.teacher1],
    );
    expect(await ok()).toBe(false);
    expect(await asUser(T.teacher1, 'select 1 from public.questions')).toHaveLength(0);
    await pool.query(
      `update organization_members set status = 'active' where organization_id = $1 and user_id = $2`,
      [T.orgId, T.teacher1],
    );
    expect(await ok()).toBe(true);
  });

  it('platform super admin is a different thing: the flag grants no organization permissions', async () => {
    const T = await createTenant('platflag');
    const p = await createUser('plat');
    await pool.query(
      `insert into profiles (id, email, full_name, is_platform_super_admin) values ($1,$2,'P',true)`,
      [p.id, p.email],
    );
    const r = (
      await asUser<{ plat: boolean; perm: boolean; member: boolean }>(
        p.id,
        `select app.is_platform_admin() as plat, app.has_permission($1, 'organization.read') as perm, app.is_org_member($1) as member`,
        [T.orgId],
      )
    )[0]!;
    expect(r).toEqual({ plat: true, perm: false, member: false });
  });

  it('role definitions cannot be changed by any user, not even an owner', async () => {
    const T = await createTenant('roledefs');
    const before = (
      await pool.query(
        'select (select count(*) from roles)::int r, (select count(*) from permissions)::int p, (select count(*) from role_permissions)::int rp',
      )
    ).rows[0];
    // Every statement must either be refused with an error or touch zero rows.
    for (const sql of [
      `insert into public.roles (code, name) values ('HACK', 'Hack')`,
      `update public.roles set name = 'x'`,
      `delete from public.roles`,
      `insert into public.permissions (code) values ('hack.all')`,
      `update public.permissions set code = 'x'`,
      `delete from public.permissions`,
      `insert into public.role_permissions (role_id, permission_id) select r.id, p.id from roles r, permissions p where r.code = 'STUDENT' and p.code = 'user.update'`,
      `delete from public.role_permissions`,
    ])
      await expectDenied(T.owner, sql);
    const after = (
      await pool.query(
        'select (select count(*) from roles)::int r, (select count(*) from permissions)::int p, (select count(*) from role_permissions)::int rp',
      )
    ).rows[0];
    expect(after).toEqual(before);
    const hacked = (
      await pool.query(
        `select count(*)::int c from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id where r.code = 'STUDENT' and p.code = 'user.update'`,
      )
    ).rows[0].c;
    expect(hacked).toBe(0);
  });

  it('privilege escalation is blocked: who may grant or remove which role', async () => {
    const T = await createTenant('escalate');
    const roleId = async (code: string) =>
      (await pool.query('select id from roles where code = $1', [code])).rows[0].id as string;
    const owner = await roleId('ORGANIZATION_OWNER');
    const adminRole = await roleId('ORGANIZATION_ADMIN');
    const teacher = await roleId('TEACHER');
    const insert = `insert into user_roles (organization_id, user_id, role_id) values ($1,$2,$3) returning id`;
    // nobody may grant OWNER through the API, including the owner
    for (const who of [T.student, T.teacher1, T.admin, T.owner])
      await expectDenied(who, insert, [T.orgId, T.teacher2, owner]);
    // only the owner may grant ADMIN
    for (const who of [T.student, T.teacher1, T.admin])
      await expectDenied(who, insert, [T.orgId, T.teacher2, adminRole]);
    expect(await asUser(T.owner, insert, [T.orgId, T.teacher2, adminRole])).toHaveLength(1);
    // admin may grant TEACHER; teacher and student may not
    expect(await asUser(T.admin, insert, [T.orgId, T.student2, teacher])).toHaveLength(1);
    for (const who of [T.teacher1, T.student])
      await expectDenied(who, insert, [T.orgId, T.student2, teacher]);
    // the owner role can never be removed; an admin cannot remove another admin
    const del = (role: string) =>
      `delete from public.user_roles ur using public.roles r where r.id = ur.role_id and r.code = '${role}' and ur.organization_id = $1 returning ur.id`;
    expect(await asUser(T.owner, del('ORGANIZATION_OWNER'), [T.orgId])).toHaveLength(0);
    expect(await asUser(T.admin, del('ORGANIZATION_ADMIN'), [T.orgId])).toHaveLength(0);
    expect(
      await asUser(T.owner, del('ORGANIZATION_ADMIN'), [T.orgId]).then((r) => r.length),
    ).toBeGreaterThan(0);
    // a role from another organization's member list cannot be targeted
    const B = await createTenant('escalateB');
    await expectDenied(T.owner, insert, [B.orgId, B.student, teacher]);
  });

  it('membership control: only user.update holders change status; the owner cannot be suspended by an admin', async () => {
    const T = await createTenant('membership');
    const upd = `update public.organization_members set status = 'suspended' where organization_id = $1 and user_id = $2 returning id`;
    expect(await asUser(T.admin, upd, [T.orgId, T.owner])).toHaveLength(0);
    expect(await asUser(T.teacher1, upd, [T.orgId, T.student])).toHaveLength(0);
    expect(await asUser(T.student, upd, [T.orgId, T.teacher2])).toHaveLength(0);
    expect(await asUser(T.admin, upd, [T.orgId, T.teacher2])).toHaveLength(1);
    expect(
      await asUser(
        T.owner,
        `update public.organization_members set status = 'active' where organization_id = $1 and user_id = $2 returning id`,
        [T.orgId, T.teacher2],
      ),
    ).toHaveLength(1);
    await expectDenied(
      T.owner,
      `insert into public.organization_members (organization_id, user_id) values ($1, $2)`,
      [T.orgId, T.owner],
    ); // members are added only by the backend
    await expectDenied(
      T.owner,
      `delete from public.organization_members where organization_id = $1`,
      [T.orgId],
    );
  });

  it('who can see whom: members list needs user.read; everyone sees only themselves otherwise', async () => {
    const T = await createTenant('seewho');
    const count = async (u: string) =>
      (
        await asUser(u, 'select 1 from public.organization_members where organization_id = $1', [
          T.orgId,
        ])
      ).length;
    expect(await count(T.owner)).toBe(6);
    expect(await count(T.admin)).toBe(6);
    expect(await count(T.teacher1)).toBe(1);
    expect(await count(T.student)).toBe(1);
    expect(
      (
        await asUser(T.student, 'select 1 from public.user_roles where organization_id = $1', [
          T.orgId,
        ])
      ).length,
    ).toBe(1);
    expect((await asUser(T.student, 'select 1 from public.profiles')).length).toBe(1);
  });

  it('teacher scopes can be managed only by teacher.assign_scope holders and only inside the organization', async () => {
    const T = await createTenant('scopes');
    const B = await createTenant('scopesB');
    const ins = `insert into user_scopes (organization_id, user_id, scope_type, scope_id) values ($1,$2,'subject',$3) returning id`;
    expect(await asUser(T.admin, ins, [T.orgId, T.teacher1, T.subject2])).toHaveLength(1);
    for (const who of [T.teacher1, T.teacher2, T.student])
      await expectDenied(who, ins, [T.orgId, T.teacher1, T.subject1]);
    await expect(pool.query(ins, [T.orgId, T.teacher1, B.subject1])).rejects.toThrow(
      /INVALID_SCOPE_TARGET/,
    ); // another organization's subject
    expect(
      await asUser(T.teacher1, 'select 1 from public.user_scopes where user_id = $1', [T.teacher1]),
    ).toHaveLength(2); // sees own scopes
    expect(
      await asUser(T.teacher2, 'select 1 from public.user_scopes where user_id = $1', [T.teacher1]),
    ).toHaveLength(0); // not others'
  });
});
