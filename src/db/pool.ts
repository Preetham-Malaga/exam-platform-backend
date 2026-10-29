// PURPOSE: Creates the PostgreSQL connection pool (Supabase Postgres).
// WHY: Reusing pooled connections avoids opening a new connection per request. keepAlive and the timeouts stop a
//      connection the network dropped silently from hanging a request (and its pool slot) forever.
// DEPENDS ON: DATABASE_URL, the pg package. Used by server.ts and health checks.

import pg from 'pg';

/**
 * `onError` hears about idle connections the network dropped (e.g. ECONNRESET from the hosted pooler). The pool replaces
 * them; without a listener Node treats the event as unhandled and the whole server process exits.
 */
export function createPool(
  connectionString: string,
  onError: (err: Error) => void = (err) =>
    process.stderr.write(`database connection dropped: ${err.message}
`),
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    // Opening a connection to the hosted database takes seconds (TLS + pooler), so idle connections are kept for
    // 10 minutes instead of being reopened after every pause; keepAlive keeps them from going stale.
    idleTimeoutMillis: 600_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    // Client-side limit: a query with no answer in 30 s fails (the request gets an error) instead of waiting forever.
    query_timeout: 30_000,
    // Server-side limit for the same, so the database also stops working on it.
    statement_timeout: 30_000,
  });
  pool.on('error', onError);
  return pool;
}
