// PURPOSE: Process entry point: loads config, connects dependencies, starts and stops the server.
// WHY: Graceful shutdown lets in-flight requests finish before a deploy or restart.
// DEPENDS ON: config/env.ts, app.ts, db/pool.ts, cache/redis.ts.

import { readFileSync } from 'node:fs';
import 'dotenv/config';
import { buildApp } from './app.js';
import { createRedis } from './cache/redis.js';
import { parseEnv } from './config/env.js';
import { createPool } from './db/pool.js';

function readVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const pool = createPool(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);
  await redis.connect().catch(() => undefined); // health endpoint reports Redis as "down" if unreachable

  const app = await buildApp({
    environment: env.NODE_ENV,
    version: readVersion(),
    corsOrigins: env.CORS_ORIGINS,
    logLevel: env.LOG_LEVEL,
    checks: {
      database: async () => {
        await pool.query('select 1');
      },
      redis: async () => {
        await redis.ping();
      },
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await pool.end();
      redis.disconnect();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err: unknown) => {
  // Logger is not available yet when configuration is invalid.
  process.stderr.write(
    `Fatal startup error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
