// A dropped database connection (ECONNRESET from the hosted pooler) must fail one request, never crash the server.
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { withUser } from '../src/db/context.js';
import { createPool } from '../src/db/pool.js';

function fakePool(onQuery: (client: EventEmitter, sql: string) => Promise<unknown>) {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn((sql: string) => onQuery(client, sql)),
    release: vi.fn(),
  });
  return { pool: { connect: async () => client } as unknown as Pool, client };
}

describe('database connection drops', () => {
  it('a reset during a request fails that request and destroys the client instead of crashing', async () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const { pool, client } = fakePool(async (c, sql) => {
      if (sql === 'select 1') {
        c.emit('error', reset); // would throw "Unhandled 'error' event" without a listener
        throw reset;
      }
      return { rows: [] };
    });
    await expect(withUser(pool, 'u1', (db) => db.query('select 1'))).rejects.toThrow('ECONNRESET');
    expect(client.release).toHaveBeenCalledWith(reset); // broken client is not reused
    expect(client.listenerCount('error')).toBe(0);
  });

  it('a healthy request returns the client to the pool', async () => {
    const { pool, client } = fakePool(async () => ({ rows: [{ ok: 1 }] }));
    await withUser(pool, 'u1', (db) => db.query('select 1'));
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('the pool listens for idle connections that drop', () => {
    const onError = vi.fn();
    const pool = createPool('postgres://user:pass@localhost:1/db', onError);
    expect(pool.listenerCount('error')).toBe(1);
    pool.emit('error', new Error('read ECONNRESET'));
    expect(onError).toHaveBeenCalled();
    void pool.end();
  });
});
