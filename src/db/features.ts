// PURPOSE: Which optional database updates (migrations 043-047) are applied, checked at start-up and every minute.
// WHY: The API keeps working on a database that has not been migrated yet: screens that existed before keep working,
//      and the new parts switch on by themselves after `npm run migrate` (no restart needed). New features that cannot
//      work without their tables answer 503 MIGRATION_PENDING with a clear message instead of a generic error.
// DEPENDS ON: pg Pool. Read-only catalogue queries; nothing is changed.

import type { Pool } from 'pg';
import { AppError } from '../utils/errors.js';

export const features = {
  /** 043: organization approval (pending_approval) and sign-up details. */
  approval: true,
  /** 044: details on courses, subjects, topics. */
  catalogDetails: true,
  /** 045: batches and students.batch_id. */
  batches: true,
  /** 046: live classes, recordings, materials. */
  learning: true,
  /** 047: details on students and teachers. */
  peopleDetails: true,
};
export type Feature = keyof typeof features;

const MIGRATION: Record<Feature, string> = {
  approval: '043',
  catalogDetails: '044',
  batches: '045',
  learning: '046',
  peopleDetails: '047',
};

export async function refreshFeatures(pool: Pool): Promise<void> {
  const r = await pool.query(`select
      exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'organizations' and column_name = 'approved_at') as approval,
      exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'courses' and column_name = 'details') as "catalogDetails",
      to_regclass('public.batches') is not null as batches,
      to_regclass('public.live_classes') is not null as learning,
      exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'students' and column_name = 'details') as "peopleDetails"`);
  Object.assign(features, r.rows[0]);
}

/** Checks now, then every minute. A failed check keeps the last known state. */
export function watchFeatures(pool: Pool): Promise<void> {
  const tick = () => refreshFeatures(pool).catch(() => undefined);
  setInterval(tick, 60_000).unref();
  return tick();
}

/** For endpoints that cannot work without their tables. */
export function requireFeature(f: Feature): void {
  if (!features[f])
    throw new AppError(
      503,
      'MIGRATION_PENDING',
      `This part needs a database update that has not been applied yet (migration ${MIGRATION[f]}). Ask your administrator to run "npm run migrate".`,
    );
}
