// PURPOSE: The server-resolved identity of the caller (user, organization, roles, permissions).
// WHY: Organization, role and permissions are NEVER taken from client input; they are derived from membership.
// DEPENDS ON: Nothing. Created by middleware/auth.ts, read by every route.

export interface OrganizationContext {
  id: string;
  code: string;
  name: string;
  status: string;
}

export interface RequestContext {
  userId: string;
  email: string;
  fullName: string;
  isPlatformAdmin: boolean;
  organization: OrganizationContext | null;
  roles: string[];
  permissions: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
  interface FastifyInstance {
    registeredRoutes: Array<{ method: string; url: string }>;
  }
}
