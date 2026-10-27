// PURPOSE: Links a person record (teacher or student) to a login: finds/creates the Supabase user (invitation e-mail),
//          makes it a member with the matching role and stores user_id on the record - all in one transaction.
// WHY: Teachers and students follow exactly the same rules; one implementation keeps them identical.
// DEPENDS ON: invite.ts, SQL app.add_member (037), tables teachers (017) / students (016).

import { z } from 'zod';
import { withSystem, type Db } from '../../db/context.js';
import { AppError, fromDatabaseError } from '../../utils/errors.js';
import type { Deps } from '../deps.js';
import { ensureAuthUser } from './invite.js';

export const personEmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const personNameSchema = z.string().trim().min(2).max(150);
export const personPhoneSchema = z.string().trim().max(30).nullable();

export interface PersonKind {
  role: 'TEACHER' | 'STUDENT';
  /** Fixed table name (never user input). */
  table: 'teachers' | 'students';
  label: 'teacher' | 'student';
}
export const TEACHER: PersonKind = { role: 'TEACHER', table: 'teachers', label: 'teacher' };
export const STUDENT: PersonKind = { role: 'STUDENT', table: 'students', label: 'student' };

/**
 * The login must not already belong to this organization with another role: add_member would ADD the role next to the
 * existing one (user_roles allows several), against "one role per person".
 */
async function assertNotOtherMember(
  d: Deps,
  org: string,
  email: string,
  kind: PersonKind,
): Promise<void> {
  const roles = await withSystem(d.pool, async (db) =>
    (
      await db.query(
        `select r.code from auth.users au
         join public.organization_members m on m.user_id = au.id and m.organization_id = $1 and m.status <> 'removed'
         join public.user_roles ur on ur.organization_id = m.organization_id and ur.user_id = m.user_id
         join public.roles r on r.id = ur.role_id
         where lower(au.email) = lower($2)`,
        [org, email],
      )
    ).rows.map((x) => x.code as string),
  );
  const other = roles.filter((r) => r !== kind.role);
  if (other.length)
    throw new AppError(
      409,
      'ALREADY_MEMBER',
      'This person already belongs to your organization with another role. Change their role on the Users page first.',
      { roles: other },
    );
}

/**
 * Creates (or links) the login, makes it a member with kind.role and links it to the record, in one transaction.
 * With insertRow the record is created inside that transaction (new person); otherwise person.id is updated.
 * A login created by this call is deleted again if anything fails.
 */
export async function linkLogin(
  d: Deps,
  org: string,
  actor: string,
  kind: PersonKind,
  person: { id: string | null; email: string; fullName: string },
  insertRow?: (db: Db, userId: string) => Promise<string>,
): Promise<string> {
  await assertNotOtherMember(d, org, person.email, kind);
  const user = await ensureAuthUser(d.pool, d.gateway, person.email, `${d.frontendUrl}/login`);
  try {
    return await withSystem(d.pool, async (db) => {
      const taken = await db.query(
        `select 1 from public.${kind.table} where organization_id = $1 and user_id = $2 and deleted_at is null
           and id is distinct from $3`,
        [org, user.id, person.id],
      );
      if (taken.rowCount)
        throw new AppError(
          409,
          `${kind.role}_EXISTS`,
          `A ${kind.label} record already uses this login.`,
        );
      await db.query('select app.add_member($1,$2,$3,$4,$5,$6)', [
        org,
        user.id,
        person.email,
        person.fullName,
        kind.role,
        actor,
      ]);
      if (insertRow) return insertRow(db, user.id);
      await db.query(
        `update public.${kind.table} set user_id = $1, updated_by = $2 where organization_id = $3 and id = $4`,
        [user.id, actor, org, person.id],
      );
      return person.id!;
    });
  } catch (err) {
    if (user.created) await d.gateway.deleteUser(user.id).catch(() => undefined);
    throw fromDatabaseError(err) ?? err;
  }
}

/** Keeps the login in step with the record: inactive => membership suspended, active => active again. */
export async function syncMembershipStatus(
  db: Db,
  org: string,
  actor: string,
  userId: string,
  status: 'active' | 'inactive',
): Promise<void> {
  await db.query(
    `update public.organization_members set status = $1, updated_by = $2
     where organization_id = $3 and user_id = $4 and status in ('active', 'suspended')`,
    [status === 'inactive' ? 'suspended' : 'active', actor, org, userId],
  );
}

/** Recommended removal (guide 13.1): the membership is removed; the soft-deleted record keeps the history. */
export async function removeMembership(
  db: Db,
  org: string,
  actor: string,
  userId: string,
): Promise<void> {
  await db.query(
    `update public.organization_members set status = 'removed', updated_by = $1
     where organization_id = $2 and user_id = $3`,
    [actor, org, userId],
  );
}
