// PURPOSE: Checks API, database and Redis connectivity for the health endpoint.
// WHY: Load balancers and uptime monitors need a truthful answer about dependencies.
// DEPENDS ON: Checker functions injected from server.ts (pg pool, Redis client).

export type DependencyStatus = 'up' | 'down';

export interface HealthChecks {
  database: () => Promise<void>;
  redis: () => Promise<void>;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  api: 'up';
  database: DependencyStatus;
  redis: DependencyStatus;
  version: string;
  environment: string;
}

const CHECK_TIMEOUT_MS = 3_000;

async function probe(check: () => Promise<void>): Promise<DependencyStatus> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function buildHealthReport(
  checks: HealthChecks,
  meta: { version: string; environment: string },
): Promise<HealthReport> {
  const [database, redis] = await Promise.all([probe(checks.database), probe(checks.redis)]);
  return {
    status: database === 'up' && redis === 'up' ? 'ok' : 'degraded',
    api: 'up',
    database,
    redis,
    version: meta.version,
    environment: meta.environment,
  };
}
