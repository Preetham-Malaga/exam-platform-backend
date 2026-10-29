// Regression for "Unable to create organization": Supabase sign-up errors keep their real reason and point at a field.
import { describe, expect, it } from 'vitest';
import { signUpError } from '../src/auth/gateway.js';
import { fail } from '../src/utils/response.js';

describe('sign-up errors from Supabase Auth', () => {
  it('the mailer rate limit (the usual cause) says so, instead of "could not create the account"', () => {
    const e = signUpError({
      code: 'over_email_send_rate_limit',
      message: 'email rate limit exceeded',
      status: 429,
    });
    expect(e.status).toBe(429);
    expect(e.code).toBe('EMAIL_RATE_LIMITED');
    expect(e.message).toMatch(/try again in an hour/);
  });
  it('an address Supabase refuses is reported on the email field', () => {
    const e = signUpError({
      code: 'email_address_invalid',
      message: 'Email address "x@y.test" is invalid',
      status: 400,
    });
    expect([e.code, e.field]).toEqual(['EMAIL_INVALID', 'email']);
  });
  it('an existing account and a weak password point at their fields', () => {
    expect(
      signUpError({ code: 'user_already_exists', message: 'User already registered' }).field,
    ).toBe('email');
    expect(
      signUpError({ code: 'weak_password', message: 'Password should be stronger' }).field,
    ).toBe('password');
  });
  it('anything else keeps the Supabase code in the message so it can be traced', () => {
    expect(
      signUpError({ code: 'unexpected_failure', message: 'boom', status: 500 }).message,
    ).toMatch(/unexpected_failure/);
  });
  it('the error envelope carries the field', () => {
    expect(fail('EMAIL_INVALID', 'm', 'r1', undefined, 'email').error).toEqual({
      code: 'EMAIL_INVALID',
      message: 'm',
      field: 'email',
    });
    expect(fail('X', 'm', 'r1').error).toEqual({ code: 'X', message: 'm' });
  });
});
