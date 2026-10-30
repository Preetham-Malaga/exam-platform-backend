// withTokenCache: one Supabase Auth check per token per 30 s, never past the token's expiry, failures never cached.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTokenCache, type AuthGateway } from '../src/auth/gateway.js';

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;

function fakeGateway(valid = true) {
  const verifyToken = vi.fn(async () =>
    valid ? { id: 'u1', email: 'a@b.test', emailConfirmed: true } : null,
  );
  const gateway = { verifyToken } as unknown as AuthGateway;
  return { gateway, verifyToken };
}

describe('withTokenCache', () => {
  afterEach(() => vi.useRealTimers());

  it('asks Supabase once for repeated calls with the same token, again after the ttl', async () => {
    vi.useFakeTimers();
    const { gateway, verifyToken } = fakeGateway();
    const cached = withTokenCache(gateway, 30_000);
    const token = jwt(Math.floor(Date.now() / 1000) + 3600);
    await cached.verifyToken(token);
    await cached.verifyToken(token);
    expect(verifyToken).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    await cached.verifyToken(token);
    expect(verifyToken).toHaveBeenCalledTimes(2);
  });

  it('never caches a refused token', async () => {
    const { gateway, verifyToken } = fakeGateway(false);
    const cached = withTokenCache(gateway);
    const token = jwt(Math.floor(Date.now() / 1000) + 3600);
    expect(await cached.verifyToken(token)).toBeNull();
    expect(await cached.verifyToken(token)).toBeNull();
    expect(verifyToken).toHaveBeenCalledTimes(2);
  });

  it('does not keep a token past its own expiry', async () => {
    const { gateway, verifyToken } = fakeGateway();
    const cached = withTokenCache(gateway, 30_000);
    const expired = jwt(Math.floor(Date.now() / 1000) - 1);
    await cached.verifyToken(expired);
    await cached.verifyToken(expired);
    expect(verifyToken).toHaveBeenCalledTimes(2);
  });
});
