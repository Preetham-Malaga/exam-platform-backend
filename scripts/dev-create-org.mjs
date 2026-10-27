// PURPOSE: DEVELOPMENT helper that creates a verified owner login + a new organization (so you can try Phase 4 before the Phase 5 sign-up screens exist).
// WHY: Uses the same database function as real registration (app.register_organization): all rows are created together or not at all.
// SAFETY: refuses to run when NODE_ENV=production. Needs the backend .env (service role key stays on your machine, never in the frontend).
// USAGE:  node scripts/dev-create-org.mjs --email owner@college.test --password "Passw0rd!x" --owner "Asha Verma" --org "Demo College" --type engineering
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const TYPES = ['engineering', 'degree', 'school', 'mba', 'coaching', 'training'];
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (process.env.NODE_ENV === 'production')
  fail('Refusing to run: this is a development helper (NODE_ENV=production).');

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i];
  if (!key?.startsWith('--') || argv[i + 1] === undefined)
    fail(`Unexpected argument "${key ?? ''}". See the usage line at the top of this file.`);
  args[key.slice(2)] = argv[i + 1];
}

const { email, password, owner, org, type = 'engineering' } = args;
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Give a valid --email.');
if (!password || password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password))
  fail('--password needs at least 8 characters with a letter and a number.');
if (!owner || owner.trim().length < 2) fail('Give --owner "Full Name".');
if (!org || org.trim().length < 2) fail('Give --org "Organization name".');
if (!TYPES.includes(type)) fail(`--type must be one of: ${TYPES.join(', ')}.`);
for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL']) {
  if (!process.env[name]) fail(`${name} is missing in .env`);
}

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (created.error || !created.data.user)
  fail(`Could not create the login: ${created.error?.message ?? 'unknown error'}`);
const userId = created.data.user.id;

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await db.connect();
  const r = await db.query('select app.register_organization($1, $2, $3, $4, $5) as id', [
    userId,
    email,
    owner.trim(),
    org.trim(),
    type,
  ]);
  const orgId = r.rows[0].id;
  await db.query('select app.activate_organization($1)', [orgId]); // the email is already confirmed
  const code = (await db.query('select org_code from public.organizations where id = $1', [orgId]))
    .rows[0].org_code;
  process.stdout.write(
    `\nCreated organization ${code} "${org.trim()}" (${type}).\nOwner login: ${email}\nNext: start the frontend and sign in at http://localhost:5173/dev/signin\n`,
  );
} catch (err) {
  await admin.auth.admin.deleteUser(userId).catch(() => undefined); // never leave a login without an organization
  fail(`Organization was NOT created (the login was removed again): ${err.message}`);
} finally {
  await db.end().catch(() => undefined);
}
