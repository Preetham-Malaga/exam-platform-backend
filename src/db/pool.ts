// PURPOSE: Creates the PostgreSQL connection pool (Supabase Postgres).
// WHY: Reusing pooled connections avoids opening a new connection per request.
// DEPENDS ON: DATABASE_URL, the pg package. Used by server.ts and health checks.

import pg from 'pg';

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}
