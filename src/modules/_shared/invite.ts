// PURPOSE: Finds or creates the Supabase Auth user for an invited person (teacher/student/admin).
// WHY: Invitations must be idempotent: inviting an email that already has an account links it, never duplicates it.
// DEPENDS ON: auth/gateway.ts, auth.users (read via the backend's system connection).

import type { Pool } from 'pg';
import type { AuthGateway } from '../../auth/gateway.js';

export async function ensureAuthUser(
  pool: Pool,
  gateway: AuthGateway,
  email: string,
  redirectTo: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await pool.query(
    'select id from auth.users where lower(email) = lower($1) limit 1',
    [email],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id as string, created: false };
  const invited = await gateway.inviteUser(email, redirectTo);
  return { id: invited.id, created: true };
}
