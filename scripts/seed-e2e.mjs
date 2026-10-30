// PURPOSE: Creates (or repairs) the fixed end-to-end test accounts: one organization with an owner, an admin, a teacher
//          and a student, each with a confirmed e-mail and the same password. Safe to run again: it only fills what is missing
//          and re-sets the password, so a broken test account is fixed by running it once more.
// WHY: Playwright tests (frontend tests/e2e) sign in as each role. Uses the same database functions as real registration
//      (app.register_organization, app.add_member) and links teacher/student records the way an accepted invitation does.
// SAFETY: refuses to run when NODE_ENV=production. Needs the backend .env (the service role key stays on this machine).
//         The password is never printed: it comes from E2E_PASSWORD, or from / into the --accounts-file (git-ignored .env.e2e).
// USAGE:  node scripts/seed-e2e.mjs --accounts-file tests/frontend/.env.e2e
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
if (process.env.NODE_ENV === 'production')
  fail('Refusing to run: this creates test accounts (NODE_ENV=production).');
for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL'])
  if (!process.env[name]) fail(`${name} is missing in .env`);

const argv = process.argv.slice(2);
const envFile = argv[argv.indexOf('--accounts-file') + 1];
if (!argv.includes('--accounts-file') || !envFile) fail('Give --accounts-file <path to .env.e2e>.');

const DOMAIN = process.env.E2E_EMAIL_DOMAIN ?? 'exam-platform.test';
const ORG_NAME = 'E2E Test College';
const ACCOUNTS = [
  { role: 'owner', code: 'ORGANIZATION_OWNER', name: 'E2E Owner' },
  { role: 'admin', code: 'ORGANIZATION_ADMIN', name: 'E2E Admin' },
  { role: 'teacher', code: 'TEACHER', name: 'E2E Teacher' },
  { role: 'student', code: 'STUDENT', name: 'E2E Student' },
].map((a) => ({ ...a, email: `e2e.${a.role}@${DOMAIN}` }));

// Password: environment, then the existing env file, else a new random one written to the env file.
const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
const fromFile = /^E2E_PASSWORD=(.+)$/m.exec(existing)?.[1]?.trim();
const password =
  process.env.E2E_PASSWORD ?? fromFile ?? `E2e-${randomBytes(12).toString('base64url')}9`;

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function ensureLogin(email) {
  const found = await db.query('select id from auth.users where lower(email) = lower($1)', [email]);
  if (found.rows[0]) {
    const r = await admin.auth.admin.updateUserById(found.rows[0].id, {
      password,
      email_confirm: true,
    });
    if (r.error) fail(`Could not update ${email}: ${r.error.message}`);
    return found.rows[0].id;
  }
  const r = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (r.error || !r.data.user) fail(`Could not create ${email}: ${r.error?.message ?? 'unknown'}`);
  return r.data.user.id;
}

try {
  const ids = {};
  for (const a of ACCOUNTS) ids[a.role] = await ensureLogin(a.email);
  const owner = ACCOUNTS[0];

  let orgId = (
    await db.query(
      `select m.organization_id from organization_members m
       join user_roles ur on ur.organization_id = m.organization_id and ur.user_id = m.user_id
       join roles r on r.id = ur.role_id and r.code = 'ORGANIZATION_OWNER'
       where m.user_id = $1 limit 1`,
      [ids.owner],
    )
  ).rows[0]?.organization_id;
  if (!orgId) {
    orgId = (
      await db.query('select app.register_organization($1, $2, $3, $4, $5) as id', [
        ids.owner,
        owner.email,
        owner.name,
        ORG_NAME,
        'engineering',
      ])
    ).rows[0].id;
    await db.query('select app.activate_organization($1)', [orgId]);
  }

  await db.query('begin');
  for (const a of ACCOUNTS.slice(1))
    await db.query('select app.add_member($1, $2, $3, $4, $5, $6)', [
      orgId,
      ids[a.role],
      a.email,
      a.name,
      a.code,
      ids.owner,
    ]);
  const teacher = ACCOUNTS.find((a) => a.role === 'teacher');
  await db.query(
    `insert into teachers (organization_id, user_id, employee_code, full_name, email, created_by)
     select $1, $2, 'E2E-T1', $3, $4, $5
     where not exists (select 1 from teachers where organization_id = $1 and user_id = $2 and deleted_at is null)`,
    [orgId, ids.teacher, teacher.name, teacher.email, ids.owner],
  );
  const student = ACCOUNTS.find((a) => a.role === 'student');
  await db.query(
    `insert into students (organization_id, user_id, roll_number, full_name, email, created_by)
     select $1, $2, 'E2E-S1', $3, $4, $5
     where not exists (select 1 from students where organization_id = $1 and user_id = $2 and deleted_at is null)`,
    [orgId, ids.student, student.name, student.email, ids.owner],
  );
  await db.query('commit');

  const lines = [
    '# End-to-end test accounts (scripts/seed-e2e.mjs in the backend). Git-ignored: never commit this file.',
    `E2E_PASSWORD=${password}`,
    ...ACCOUNTS.map((a) => `E2E_${a.role.toUpperCase()}_EMAIL=${a.email}`),
    '',
  ];
  fs.writeFileSync(envFile, lines.join('\n'));
  const code = (await db.query('select org_code from organizations where id = $1', [orgId])).rows[0]
    .org_code;
  process.stdout.write(
    `E2E organization "${ORG_NAME}" (${code}) is ready with:\n` +
      ACCOUNTS.map((a) => `  ${a.role.padEnd(8)} ${a.email}`).join('\n') +
      `\nAccounts and password written to ${envFile} (the password is not printed).\n`,
  );
} catch (error) {
  await db.query('rollback').catch(() => undefined);
  fail(`Seeding failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await db.end();
}
