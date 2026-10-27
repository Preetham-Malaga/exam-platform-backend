// PURPOSE: Validation and small SQL helpers shared by the academic structure routes (levels, units, courses, subjects, topics).
// WHY: The same code/name/status rules and the same "is this record still in use?" check apply to every academic table.
// DEPENDS ON: db/context.ts, utils/errors.ts. Table and column names below are fixed whitelists, never user input.

import type { Pool } from 'pg';
import { z } from 'zod';
import { withSystem, type Db } from '../../db/context.js';
import { AppError, notFound } from '../../utils/errors.js';

export const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, digits, ".", "_" or "-" (no spaces).');
export const nameSchema = z.string().trim().min(1).max(150);
export const descriptionSchema = z.string().trim().max(1000).nullable();
export const statusSchema = z.enum(['active', 'inactive']);
export const idParams = z.object({ id: z.uuid() });
/** Query-string filter: a uuid, or absent. */
export const optionalId = z.uuid().optional();

/** Turns "Program Name" into "program_name" (same rule as app.register_organization uses for default levels). */
export const slug = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30) || 'level';

/** Builds "col = $n" pairs for the fields present in body. */
export function buildSet(
  body: Record<string, unknown>,
  columns: Record<string, string>,
): { sets: string[]; vals: unknown[] } {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, col] of Object.entries(columns)) {
    if (body[key] !== undefined) {
      vals.push(body[key]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  return { sets, vals };
}

type ActiveTable = 'academic_levels' | 'academic_units' | 'courses' | 'subjects';

/**
 * Inside the caller's RLS transaction: the referenced row exists in the caller's organization, is visible to them
 * and (where the table has soft delete) is not deleted. Gives a clear 404 instead of a foreign-key error.
 */
export async function assertActive(
  db: Db,
  table: ActiveTable,
  org: string,
  id: string,
  label: string,
): Promise<void> {
  const notDeleted = table === 'academic_levels' ? '' : ' and deleted_at is null';
  const r = await db.query(
    `select 1 from public.${table} where organization_id = $1 and id = $2${notDeleted}`,
    [org, id],
  );
  if (!r.rowCount) throw notFound(label);
}

/**
 * Counts active rows that still point at a record. Runs as the system (filtered by organization) so the answer does not
 * depend on what the caller can see: a teacher must not delete a topic just because another teacher's question is hidden.
 */
export async function assertNotInUse(
  pool: Pool,
  org: string,
  id: string,
  code: string,
  message: string,
  refs: Record<string, { table: string; column: string; softDelete?: boolean }>,
): Promise<void> {
  const counts = await withSystem(pool, async (db) => {
    const out: Record<string, number> = {};
    for (const [label, ref] of Object.entries(refs)) {
      const alive = ref.softDelete === false ? '' : ' and deleted_at is null';
      out[label] = (
        await db.query(
          `select count(*)::int as c from public.${ref.table} where organization_id = $1 and ${ref.column} = $2${alive}`,
          [org, id],
        )
      ).rows[0].c as number;
    }
    return out;
  });
  if (Object.values(counts).some((c) => c > 0)) throw new AppError(409, code, message, counts);
}

/** Splits the window-function total off list rows. */
export function withTotal(rows: Array<Record<string, unknown>>): {
  items: Array<Record<string, unknown>>;
  total: number;
} {
  return {
    items: rows.map(({ __total, ...r }) => r),
    total: rows.length ? Number(rows[0]!['__total']) : 0,
  };
}
