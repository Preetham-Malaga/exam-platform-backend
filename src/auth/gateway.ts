// PURPOSE: The only place that talks to Supabase Auth (verify token, sign up, sign in, invite, delete user).
// WHY: Services depend on this interface, so tests can supply a fake and nothing else knows about supabase-js.
// DEPENDS ON: @supabase/supabase-js. Used by auth middleware and auth/people services.

import { createClient } from '@supabase/supabase-js';
import { AppError } from '../utils/errors.js';

export interface AuthUser {
  id: string;
  email: string;
  emailConfirmed: boolean;
}
export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}

export interface AuthGateway {
  verifyToken(token: string): Promise<AuthUser | null>;
  signUp(email: string, password: string, redirectTo?: string): Promise<{ id: string }>;
  signIn(email: string, password: string): Promise<Session>;
  inviteUser(email: string, redirectTo?: string): Promise<{ id: string }>;
  deleteUser(id: string): Promise<void>;
}

export function createSupabaseGateway(opts: {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}): AuthGateway {
  const settings = { auth: { persistSession: false, autoRefreshToken: false } } as const;
  const anon = createClient(opts.url, opts.anonKey, settings);
  const admin = createClient(opts.url, opts.serviceRoleKey, settings);

  return {
    async verifyToken(token) {
      const { data, error } = await anon.auth.getUser(token);
      if (error || !data.user) return null;
      return {
        id: data.user.id,
        email: data.user.email ?? '',
        emailConfirmed: Boolean(data.user.email_confirmed_at),
      };
    },
    async signUp(email, password, redirectTo) {
      const { data, error } = await anon.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: redirectTo },
      });
      if (error) {
        if (/registered|exists/i.test(error.message))
          throw new AppError(409, 'EMAIL_IN_USE', 'An account with this email already exists.');
        if (/password/i.test(error.message))
          throw new AppError(
            400,
            'WEAK_PASSWORD',
            'Choose a stronger password (at least 8 characters).',
          );
        throw new AppError(
          400,
          'SIGNUP_FAILED',
          'We could not create the account. Please check the details and try again.',
        );
      }
      // With email confirmation on, an already-registered address returns a user with no identities.
      if (!data.user || (data.user.identities && data.user.identities.length === 0)) {
        throw new AppError(409, 'EMAIL_IN_USE', 'An account with this email already exists.');
      }
      return { id: data.user.id };
    },
    async signIn(email, password) {
      const { data, error } = await anon.auth.signInWithPassword({ email, password });
      if (error || !data.session) {
        if (error && /confirm/i.test(error.message))
          throw new AppError(
            403,
            'EMAIL_NOT_VERIFIED',
            'Please verify your email before signing in.',
          );
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
      }
      return {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at ?? null,
      };
    },
    async inviteUser(email, redirectTo) {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (error || !data.user)
        throw new AppError(
          400,
          'INVITE_FAILED',
          'We could not send the invitation. Please check the email address.',
        );
      return { id: data.user.id };
    },
    async deleteUser(id) {
      await admin.auth.admin.deleteUser(id);
    },
  };
}
