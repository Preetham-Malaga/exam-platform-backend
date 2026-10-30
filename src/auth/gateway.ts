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

/** The JWT's own expiry (seconds since epoch), read without verifying; only used to shorten the cache below. */
function tokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Remembers a successfully verified token for a short time (default 30 s, never past the token's expiry), so a page
 * that makes several API calls asks Supabase Auth once instead of once per call. Failed checks are never cached.
 * Trade-off: a session revoked elsewhere keeps working for at most `ttlMs` on this server.
 */
export function withTokenCache(
  gateway: AuthGateway,
  ttlMs = 30_000,
  maxEntries = 5_000,
): AuthGateway {
  const cache = new Map<string, { user: AuthUser; until: number }>();
  return {
    ...gateway,
    async verifyToken(token) {
      const now = Date.now();
      const hit = cache.get(token);
      if (hit && hit.until > now) return hit.user;
      cache.delete(token);
      const user = await gateway.verifyToken(token);
      if (user) {
        const exp = tokenExpiry(token);
        const until = Math.min(now + ttlMs, exp ? exp * 1000 : now + ttlMs);
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
        if (until > now) cache.set(token, { user, until });
      }
      return user;
    },
  };
}

/**
 * Supabase Auth sign-up errors as clear API errors. Before this, every reason (rate limit, address refused …) came back
 * as "We could not create the account", the "Unable to create organization" bug: the usual cause was Supabase's
 * built-in mailer limit (a few e-mails an hour) until the project has its own SMTP server.
 */
/** Supabase invite failures with their real reason (the most common: the built-in mailer's hourly limit). */
export function inviteError(error: {
  code?: string | undefined;
  message: string;
  status?: number | undefined;
}): AppError {
  const code = error.code ?? '';
  if (
    code === 'over_email_send_rate_limit' ||
    code === 'over_request_rate_limit' ||
    error.status === 429
  )
    return new AppError(
      429,
      'EMAIL_RATE_LIMITED',
      "The invitation e-mail can't be sent right now: too many e-mails were sent in the last hour. Try again later, or set up your own e-mail provider (SMTP) in Supabase.",
    );
  if (code === 'email_address_invalid' || code === 'email_address_not_authorized')
    return new AppError(
      400,
      'EMAIL_INVALID',
      'This e-mail address cannot receive mail. Use a real address.',
      undefined,
      'email',
    );
  return new AppError(
    502,
    'INVITE_FAILED',
    `The invitation e-mail could not be sent (${error.message || code || 'unknown reason'}).`,
  );
}

export function signUpError(error: {
  code?: string | undefined;
  message: string;
  status?: number | undefined;
}): AppError {
  const code = error.code ?? '';
  if (
    code === 'over_email_send_rate_limit' ||
    code === 'over_request_rate_limit' ||
    error.status === 429
  )
    return new AppError(
      429,
      'EMAIL_RATE_LIMITED',
      "We can't send the verification e-mail right now because too many were sent recently. Please try again in an hour.",
    );
  if (
    code === 'email_address_invalid' ||
    code === 'email_address_not_authorized' ||
    /invalid/i.test(error.message)
  )
    return new AppError(
      400,
      'EMAIL_INVALID',
      'This e-mail address cannot receive mail. Use a real address you can open.',
      undefined,
      'email',
    );
  if (
    code === 'user_already_exists' ||
    code === 'email_exists' ||
    /registered|exists/i.test(error.message)
  )
    return new AppError(
      409,
      'EMAIL_IN_USE',
      'An account with this email already exists.',
      undefined,
      'email',
    );
  if (code === 'weak_password' || /password/i.test(error.message))
    return new AppError(
      400,
      'WEAK_PASSWORD',
      'Choose a stronger password: at least 8 characters with a letter and a number.',
      undefined,
      'password',
    );
  if (code === 'signup_disabled')
    return new AppError(403, 'SIGNUP_DISABLED', 'New sign-ups are switched off for this platform.');
  return new AppError(
    400,
    'SIGNUP_FAILED',
    `We could not create the account (${code || error.status || 'unknown reason'}). Please try again.`,
  );
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
      if (error) throw signUpError(error);
      // With email confirmation on, an already-registered address returns a user with no identities.
      if (!data.user || (data.user.identities && data.user.identities.length === 0)) {
        throw new AppError(
          409,
          'EMAIL_IN_USE',
          'An account with this email already exists.',
          undefined,
          'email',
        );
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
      if (error || !data.user) throw inviteError(error ?? { message: 'No user returned.' });
      return { id: data.user.id };
    },
    async deleteUser(id) {
      await admin.auth.admin.deleteUser(id);
    },
  };
}
