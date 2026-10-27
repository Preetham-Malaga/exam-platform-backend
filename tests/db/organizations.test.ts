// Phase 4 (database level): organization registration, protected columns, and tenant isolation of the organization tables.
import { afterAll, describe, expect, it } from 'vitest';
import {
  DATABASE_TEST_URL,
  asUser,
  createTenant,
  createUser,
  expectDenied,
  pool,
} from './helpers.js';

describe.skipIf(!DATABASE_TEST_URL)('organizations (real PostgreSQL)', () => {
  afterAll(() => pool.end());

  const register = async (type: string, name = `Org ${Math.random().toString(36).slice(2, 8)}`) => {
    const u = await createUser('owner');
    const id = (
      await pool.query('select app.register_organization($1,$2,$3,$4,$5) as id', [
        u.id,
        u.email,
        'Owner Name',
        name,
        type,
      ])
    ).rows[0].id as string;
    return { userId: u.id, orgId: id, name };
  };

  it('registration creates organization, settings, owner membership, owner role and a trial subscription in one step', async () => {
    const { orgId, userId } = await register('engineering');
    const r = await pool.query(
      `select o.org_code, o.status, o.institution_type,
              (select count(*) from organization_settings where organization_id = o.id)::int as settings,
              (select count(*) from organization_members where organization_id = o.id and user_id = $2 and status = 'active')::int as members,
              (select count(*) from user_roles ur join roles r on r.id = ur.role_id where ur.organization_id = o.id and ur.user_id = $2 and r.code = 'ORGANIZATION_OWNER')::int as owners,
              (select count(*) from subscriptions s join plans p on p.id = s.plan_id where s.organization_id = o.id and s.status = 'trialing' and p.code = 'trial' and s.trial_ends_at > now())::int as trials
       from organizations o where o.id = $1`,
      [orgId, userId],
    );
    expect(r.rows[0]).toMatchObject({
      status: 'pending_email',
      institution_type: 'engineering',
      settings: 1,
      members: 1,
      owners: 1,
      trials: 1,
    });
    expect(r.rows[0].org_code).toMatch(/^ORG-\d{6}$/);
  });

  it('seeds the academic hierarchy that fits the institution type (not one fixed structure)', async () => {
    const levels = async (type: string) => {
      const { orgId } = await register(type);
      return (
        await pool.query(
          'select name from academic_levels where organization_id = $1 order by position',
          [orgId],
        )
      ).rows.map((x) => x.name);
    };
    expect(await levels('engineering')).toEqual(['Program', 'Branch', 'Year', 'Semester']);
    expect(await levels('school')).toEqual(['Class', 'Section']);
    expect(await levels('coaching')).toEqual(['Program', 'Batch']);
    expect(await levels('mba')).toEqual(['Program', 'Specialization', 'Semester']);
  });

  it('org_code values are sequential-style and never repeat', async () => {
    const a = await register('school');
    const b = await register('school');
    const codes = (
      await pool.query('select org_code from organizations where id = any($1)', [
        [a.orgId, b.orgId],
      ])
    ).rows.map((r) => r.org_code as string);
    expect(new Set(codes).size).toBe(2);
    expect(Number(codes.sort()[1]!.slice(4))).toBeGreaterThan(Number(codes[0]!.slice(4)));
  });

  it('a failed registration leaves nothing behind (no half organization)', async () => {
    const u = await createUser('atomic');
    // Count only what THIS test could create: other test files register organizations in parallel.
    const badName = `Bad Org ${u.id}`;
    await expect(
      pool.query('select app.register_organization($1,$2,$3,$4,$5)', [
        u.id,
        u.email,
        'Owner',
        badName,
        'not-a-type',
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query('select app.register_organization($1,$2,$3,$4,$5)', [
        u.id,
        u.email,
        'Owner',
        'x',
        'school',
      ]),
    ).rejects.toThrow(); // name too short
    expect(
      (
        await pool.query('select count(*)::int c from organizations where name in ($1, $2)', [
          badName,
          'x',
        ])
      ).rows[0].c,
    ).toBe(0);
    expect(
      (await pool.query('select count(*)::int c from profiles where id = $1', [u.id])).rows[0].c,
    ).toBe(0);
    expect(
      (
        await pool.query('select count(*)::int c from organization_members where user_id = $1', [
          u.id,
        ])
      ).rows[0].c,
    ).toBe(0);
  });

  it('registration cannot be called by a normal signed-in user (system function)', async () => {
    const T = await createTenant('regdeny');
    await expectDenied(
      T.owner,
      `select app.register_organization(gen_random_uuid(), 'x@y.z', 'n', 'Some College', 'school')`,
    );
  });

  it('members see their own organization; other organizations are invisible', async () => {
    const A = await createTenant('orgvisA');
    const B = await createTenant('orgvisB');
    for (const user of [A.owner, A.admin, A.teacher1, A.student]) {
      const orgs = await asUser<{ id: string }>(user, 'select id from public.organizations');
      expect(orgs.map((o) => o.id)).toEqual([A.orgId]);
      expect(
        await asUser(
          user,
          'select 1 from public.organization_settings where organization_id = $1',
          [B.orgId],
        ),
      ).toHaveLength(0);
    }
    expect(
      (await asUser<{ id: string }>(B.owner, 'select id from public.organizations')).map(
        (o) => o.id,
      ),
    ).toEqual([B.orgId]);
  });

  it('only organization.update holders can edit the profile; status, code and owner of record are protected', async () => {
    const T = await createTenant('orgedit');
    expect(
      await asUser(
        T.owner,
        `update public.organizations set name = 'Renamed' where id = $1 returning id`,
        [T.orgId],
      ),
    ).toHaveLength(1);
    for (const user of [T.admin, T.teacher1, T.student]) {
      expect(
        await asUser(
          user,
          `update public.organizations set name = 'x' where id = $1 returning id`,
          [T.orgId],
        ),
        'non-owner edit',
      ).toHaveLength(0);
    }
    await expectDenied(
      T.owner,
      `update public.organizations set status = 'suspended' where id = $1`,
      [T.orgId],
    );
    await expectDenied(
      T.owner,
      `update public.organizations set org_code = 'ORG-999999' where id = $1`,
      [T.orgId],
    );
    await expectDenied(
      T.owner,
      `update public.organizations set deleted_at = now() where id = $1`,
      [T.orgId],
    );
    await expectDenied(T.owner, `delete from public.organizations where id = $1`, [T.orgId]);
    await expectDenied(
      T.owner,
      `insert into public.organizations (name, institution_type) values ('Sneaky College', 'school')`,
    );
  });

  it('owner and admin can edit settings (branding); teachers and students cannot', async () => {
    const T = await createTenant('orgsettings');
    const q = `update public.organization_settings set branding = '{"primaryColor":"#112233"}' where organization_id = $1 returning id`;
    expect(await asUser(T.owner, q, [T.orgId])).toHaveLength(1);
    expect(await asUser(T.admin, q, [T.orgId])).toHaveLength(1);
    expect(await asUser(T.teacher1, q, [T.orgId])).toHaveLength(0);
    expect(await asUser(T.student, q, [T.orgId])).toHaveLength(0);
  });

  it('suspended organizations lock their members out of every tenant table', async () => {
    const T = await createTenant('suspend');
    expect(
      (await asUser(T.owner, 'select 1 from public.students where organization_id = $1', [T.orgId]))
        .length,
    ).toBeGreaterThan(0);
    await pool.query(`update organizations set status = 'suspended' where id = $1`, [T.orgId]);
    expect(
      await asUser(T.owner, 'select 1 from public.students where organization_id = $1', [T.orgId]),
    ).toHaveLength(0);
    expect(
      await asUser(T.owner, 'select 1 from public.organizations where id = $1', [T.orgId]),
    ).toHaveLength(0);
  });
});
