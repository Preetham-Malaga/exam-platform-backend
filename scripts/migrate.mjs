// PURPOSE: Applies supabase/migrations/*.sql in order to DATABASE_URL and records them in app.migrations.
// WHY: Lets you run the migrations without installing the Supabase CLI. Safe to re-run (applied files are skipped).
// USAGE: node scripts/migrate.mjs            (real Supabase project / any Postgres that already has the auth schema)
//        node scripts/migrate.mjs --shim     (LOCAL plain Postgres only: first creates a fake Supabase auth schema/roles)
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** sha256 of the file as stored, and of its LF / CRLF forms: Git may convert line endings on checkout (Windows). */
const sha = (t) => createHash('sha256').update(t).digest('hex');
const sameExceptLineEndings = (sql, stored) =>
  [sql, sql.replace(/\r\n/g, '\n'), sql.replace(/\r?\n/g, '\r\n')].some((t) => sha(t) === stored);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is not set.\n');
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (process.argv.includes('--shim')) {
    await client.query(readFileSync(join(root, 'tests/db/supabase-shim.sql'), 'utf8'));
  }
  await client.query('create schema if not exists app');
  await client.query(
    'create table if not exists app.migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())',
  );
  const done = new Map(
    (await client.query('select name, checksum from app.migrations')).rows.map((r) => [
      r.name,
      r.checksum,
    ]),
  );
  const dir = join(root, 'supabase/migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let applied = 0;
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (done.has(file)) {
      // A file whose only change is its line endings (CRLF vs LF) is the same migration.
      if (!sameExceptLineEndings(sql, done.get(file)))
        throw new Error(
          `Migration ${file} was changed after it was applied. Create a new migration instead.`,
        );
      continue;
    }
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into app.migrations (name, checksum) values ($1, $2)', [
        file,
        checksum,
      ]);
      await client.query('commit');
      process.stdout.write(`applied ${file}\n`);
      applied += 1;
    } catch (err) {
      await client.query('rollback');
      throw new Error(`${file}: ${err.message}`, { cause: err });
    }
  }
  process.stdout.write(
    applied === 0 ? 'Database is up to date.\n' : `Done. ${applied} migration(s) applied.\n`,
  );
} finally {
  await client.end();
}
