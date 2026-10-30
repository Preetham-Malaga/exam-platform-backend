// PURPOSE: Registration (creates auth user + whole organization atomically), login proxy, and GET /me.
// WHY: Registration must never leave half an organization; /me tells the frontend who the caller is and what they may do.
// DEPENDS ON: auth/gateway.ts, SQL function app.register_organization (migration 037).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withSystem, withUser } from '../../db/context.js';
import { strictRateLimit } from '../../middleware/rateLimit.js';
import { fromDatabaseError } from '../../utils/errors.js';
import { ok } from '../../utils/response.js';
import { API, type Deps } from '../deps.js';

const password = z
  .string()
  .min(8)
  .max(72)
  .regex(/[A-Za-z]/, 'Use at least one letter')
  .regex(/\d/, 'Use at least one number');
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const registerSchema = z.object({
  organizationName: z.string().trim().min(2).max(200),
  institutionType: z.enum(['engineering', 'degree', 'school', 'mba', 'coaching', 'training']),
  ownerName: z.string().trim().min(2).max(150),
  email,
  password,
  // Prototype SPEC.signup. Optional here so older clients keep working; the sign-up form always sends them.
  city: z.string().trim().min(2).max(100).optional(),
  state: z.string().trim().min(2).max(100).optional(),
  mobile: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .pipe(
      z
        .string()
        .regex(/^(\+?91)?[6-9]\d{9}$/, 'Enter a 10-digit mobile number starting with 6, 7, 8 or 9'),
    )
    .optional(),
  heardFrom: z.string().trim().max(100).optional(),
  acceptTerms: z.literal(true, 'Accept the Terms of Service and Privacy Policy').optional(),
});

export function registerAuthRoutes(app: FastifyInstance, d: Deps): void {
  app.post(`${API}/auth/register`, strictRateLimit, async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const user = await d.gateway.signUp(body.email, body.password, `${d.frontendUrl}/verify-email`);
    try {
      const orgCode = await withSystem(d.pool, async (db) => {
        const id = (
          await db.query('select app.register_organization($1,$2,$3,$4,$5) as id', [
            user.id,
            body.email,
            body.ownerName,
            body.organizationName,
            body.institutionType,
          ])
        ).rows[0].id as string;
        await db.query(
          `update public.organizations
             set city = $2, state = $3, contact_phone = coalesce($4, contact_phone), heard_from = $5,
                 terms_accepted_at = case when $6 then now() end
           where id = $1`,
          [
            id,
            body.city ?? null,
            body.state ?? null,
            body.mobile ?? null,
            body.heardFrom ?? null,
            body.acceptTerms === true,
          ],
        );
        await db.query(
          `insert into public.audit_logs (organization_id, user_id, action, resource, resource_id, ip, request_id) values ($1,$2,'ORGANIZATION_REGISTERED','organizations',$5,$3,$4)`,
          [id, user.id, req.ip, req.id, id],
        );
        return (await db.query('select org_code from public.organizations where id = $1', [id]))
          .rows[0].org_code as string;
      });
      reply.code(201);
      return ok({ organizationCode: orgCode, emailVerificationRequired: true }, req.id);
    } catch (err) {
      await d.gateway.deleteUser(user.id).catch(() => undefined); // roll back the auth user: never keep a half-created tenant
      throw fromDatabaseError(err) ?? err;
    }
  });

  app.post(`${API}/auth/login`, strictRateLimit, async (req) => {
    const body = z.object({ email, password: z.string().min(1).max(200) }).parse(req.body);
    const session = await d.gateway.signIn(body.email, body.password);
    return ok(session, req.id);
  });

  app.get(`${API}/me`, { preHandler: d.authenticate }, async (req) => {
    const c = req.ctx;
    let scopes: Array<{ scopeType: string; scopeId: string; name: string | null }> = [];
    let studentId: string | null = null;
    // Display preferences of the caller's own organization (theme, date/time format, time zone). Everyone in the
    // organization needs them, students included, who may not read the organization itself; nothing else is returned.
    let preferences: Record<string, string | null> | null = null;
    if (c.organization)
      preferences =
        (
          await withSystem(d.pool, (db) =>
            db.query(
              `select branding->>'theme' as theme, branding->>'dateFormat' as "dateFormat",
                 branding->>'timeFormat' as "timeFormat", branding->>'weekStart' as "weekStart", timezone
               from public.organization_settings where organization_id = $1`,
              [c.organization!.id],
            ),
          )
        ).rows[0] ?? null;
    if (c.organization) {
      await withUser(d.pool, c.userId, async (db) => {
        scopes = (
          await db.query(
            `select us.scope_type as "scopeType", us.scope_id as "scopeId", coalesce(s.name, co.name, u.name) as name
           from public.user_scopes us
           left join public.subjects s on us.scope_type = 'subject' and s.id = us.scope_id
           left join public.courses co on us.scope_type = 'course' and co.id = us.scope_id
           left join public.academic_units u on us.scope_type = 'academic_unit' and u.id = us.scope_id
           where us.user_id = $1 and us.organization_id = $2`,
            [c.userId, c.organization!.id],
          )
        ).rows;
        studentId =
          (
            await db.query(
              'select id from public.students where user_id = $1 and organization_id = $2 and deleted_at is null',
              [c.userId, c.organization!.id],
            )
          ).rows[0]?.id ?? null;
      });
    }
    return ok(
      {
        user: { id: c.userId, email: c.email, fullName: c.fullName },
        isPlatformAdmin: c.isPlatformAdmin,
        organization: c.organization,
        roles: c.roles,
        permissions: c.permissions,
        scopes,
        studentId,
        preferences,
      },
      req.id,
    );
  });
}
