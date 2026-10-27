// PURPOSE: Writes append-only audit log rows (who did what, where, with which request ID).
// WHY: Accountability and investigations; the table cannot be modified by users.
// DEPENDS ON: audit_logs table (migration 034). Never stores passwords or tokens.

import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

export async function audit(
  pool: Pool,
  request: FastifyRequest,
  action: string,
  resource: string,
  resourceId?: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await pool.query(
      `insert into public.audit_logs (organization_id, user_id, action, resource, resource_id, ip, request_id, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        request.ctx?.organization?.id ?? null,
        request.ctx?.userId ?? null,
        action,
        resource,
        resourceId ?? null,
        request.ip,
        request.id,
        JSON.stringify(metadata),
      ],
    );
  } catch (err) {
    request.log.error({ err }, 'audit log write failed'); // never block the user action because logging failed
  }
}
