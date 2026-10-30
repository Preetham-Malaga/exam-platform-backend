// PURPOSE: Current-organization endpoints: profile and settings/branding (Phase 4).
// WHY: The organization is always resolved from the caller's membership; there is no organization id in any URL.
// DEPENDS ON: middleware/authorization.ts, db/context.ts.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser } from '../../db/context.js';
import { requirePermission } from '../../middleware/authorization.js';
import { audit } from '../../utils/audit.js';
import { notFound } from '../../utils/errors.js';
import { ok } from '../../utils/response.js';
import { API, type Deps } from '../deps.js';

const profileSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    contactEmail: z.string().trim().toLowerCase().max(254).pipe(z.email()).nullable(),
    contactPhone: z.string().trim().max(30).nullable(),
    address: z.string().trim().max(500).nullable(),
  })
  .partial()
  .strict();

const settingsSchema = z
  .object({
    branding: z
      .object({
        primaryColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        tagline: z.string().trim().max(200).optional(),
        /** Colour theme for everyone in the organization (prototype Settings › Branding). */
        theme: z.enum(['violet', 'ocean', 'forest', 'sunset']).optional(),
        /** Prototype Settings › Date & time: used by every table, window, schedule and PDF. */
        dateFormat: z.enum(['DD-MM-YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY']).optional(),
        timeFormat: z.enum(['12', '24']).optional(),
        weekStart: z.enum(['Monday', 'Sunday']).optional(),
      })
      .strict()
      .optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$/, 'Use a time zone name like Asia/Kolkata.')
      .optional(),
  })
  .strict();

export function registerOrganizationRoutes(app: FastifyInstance, d: Deps): void {
  const base = `${API}/organizations/current`;

  app.get(
    base,
    { preHandler: [d.authenticate, requirePermission('organization.read')] },
    async (req) => {
      const row = await withUser(
        d.pool,
        req.ctx.userId,
        async (db) =>
          (
            await db.query(
              `select o.id, o.org_code as "orgCode", o.name, o.institution_type as "institutionType", o.status,
                o.contact_email as "contactEmail", o.contact_phone as "contactPhone", o.address,
                s.branding, s.timezone, o.created_at as "createdAt"
         from public.organizations o join public.organization_settings s on s.organization_id = o.id where o.id = $1`,
              [req.ctx.organization!.id],
            )
          ).rows[0],
      );
      if (!row) throw notFound('Organization');
      return ok(row, req.id);
    },
  );

  app.patch(
    base,
    { preHandler: [d.authenticate, requirePermission('organization.update')] },
    async (req) => {
      const body = profileSchema.parse(req.body);
      const map: Record<string, string> = {
        name: 'name',
        contactEmail: 'contact_email',
        contactPhone: 'contact_phone',
        address: 'address',
      };
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, col] of Object.entries(map)) {
        const v = (body as Record<string, unknown>)[k];
        if (v !== undefined) {
          vals.push(v);
          sets.push(`${col} = $${vals.length}`);
        }
      }
      if (!sets.length) return ok({ updated: false }, req.id);
      vals.push(req.ctx.organization!.id);
      const r = await withUser(d.pool, req.ctx.userId, (db) =>
        db.query(
          `update public.organizations set ${sets.join(', ')} where id = $${vals.length} returning id`,
          vals,
        ),
      );
      if (!r.rowCount) throw notFound('Organization');
      await audit(d.pool, req, 'ORGANIZATION_UPDATED', 'organizations', req.ctx.organization!.id);
      return ok({ updated: true }, req.id);
    },
  );

  app.patch(
    `${base}/settings`,
    { preHandler: [d.authenticate, requirePermission('settings.update')] },
    async (req) => {
      const body = settingsSchema.parse(req.body);
      const r = await withUser(d.pool, req.ctx.userId, (db) =>
        db.query(
          `update public.organization_settings set branding = branding || coalesce($1::jsonb, '{}'::jsonb), timezone = coalesce($2, timezone), updated_by = $3
       where organization_id = $4 returning branding, timezone`,
          [
            body.branding ? JSON.stringify(body.branding) : null,
            body.timezone ?? null,
            req.ctx.userId,
            req.ctx.organization!.id,
          ],
        ),
      );
      if (!r.rowCount) throw notFound('Settings');
      await audit(
        d.pool,
        req,
        'SETTINGS_UPDATED',
        'organization_settings',
        req.ctx.organization!.id,
      );
      return ok(r.rows[0], req.id);
    },
  );
}
