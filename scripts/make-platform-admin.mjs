// PURPOSE: Marks an existing login as platform staff (profiles.is_platform_super_admin), or removes that mark.
// WHY: Platform staff approve new organizations (/platform/organizations, migration 043). There is no screen to create
//      the first one, so it is done once from the backend machine.
// SAFETY: needs the backend .env (DATABASE_URL); changes one flag on one profile; prints nothing secret.
// USAGE:  node scripts/make-platform-admin.mjs --email you@company.com [--remove]
import 'dotenv/config';
import pg from 'pg';

const argv = process.argv.slice(2);
const email = argv[argv.indexOf('--email') + 1];
const remove = argv.includes('--remove');
if (!argv.includes('--email') || !email || email.startsWith('--')) {
  process.stderr.write('Give --email <address of an existing login>.\n');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is missing in .env\n');
  process.exit(1);
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const user = (await db.query('select id from auth.users where lower(email) = lower($1)', [email]))
    .rows[0];
  if (!user) {
    process.stderr.write(`No login found for ${email}. Sign up or create the login first.\n`);
    process.exit(1);
  }
  await db.query(
    `insert into public.profiles (id, email, full_name, is_platform_super_admin) values ($1, $2, '', $3)
     on conflict (id) do update set is_platform_super_admin = excluded.is_platform_super_admin`,
    [user.id, email, !remove],
  );
  process.stdout.write(
    remove
      ? `${email} is no longer platform staff.\n`
      : `${email} is now platform staff. Sign in and open /platform/organizations to approve organizations.\n`,
  );
} finally {
  await db.end();
}
