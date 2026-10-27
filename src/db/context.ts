// PURPOSE: Runs SQL either AS THE LOGGED-IN USER (RLS applies) or as the system (backend-only operations).
// WHY: Row Level Security is the final tenant wall; user-context queries make PostgreSQL enforce it for every request.
// DEPENDS ON: pg Pool. Used by every service/repository.

import type { Pool, PoolClient } from 'pg';

export type Db = Pick<PoolClient, 'query'>;

/** Runs fn inside a transaction with the database role switched to "authenticated" and auth.uid() = userId. */
export async function withUser<T>(
  pool: Pool,
  userId: string,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('request.jwt.claims', $1, true),
              set_config('request.jwt.claim.sub', $2, true),
              set_config('request.jwt.claim.role', 'authenticated', true)`,
      [JSON.stringify({ sub: userId, role: 'authenticated' }), userId],
    );
    await client.query('set local role authenticated');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Runs fn in a transaction with full backend privileges (bypasses RLS). Use only for server-controlled work. */
export async function withSystem<T>(pool: Pool, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
