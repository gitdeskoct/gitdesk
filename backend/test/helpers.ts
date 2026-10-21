import { env } from 'cloudflare:workers';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload } from 'jose';
import { createApp } from '../src/app';
import { randomToken, sha256 } from '../src/lib/crypto';
import { verifyGoogleIdToken, type GoogleProvider } from '../src/modules/auth/google';

export const CLIENT_ID = env.GOOGLE_CLIENT_ID;

export async function googleKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256' }],
  });
  const sign = (claims: JWTPayload, opts: { iss?: string; aud?: string; exp?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(opts.iss ?? 'https://accounts.google.com')
      .setAudience(opts.aud ?? CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '5m')
      .sign(privateKey);
  return { jwks, sign };
}

// Real ID-token verification against a locally signed key; only the network calls are faked.
export async function fakeGoogle() {
  const { jwks, sign } = await googleKeys();
  const state = {
    nonce: '',
    claims: {
      sub: 'google-subject-1',
      email: 'person@example.com',
      email_verified: true,
      name: 'Test Person',
    } as JWTPayload,
  };
  const provider: GoogleProvider = {
    exchangeCode: async () => sign({ ...state.claims, nonce: state.nonce }),
    verifyIdToken: (idToken, expected) => verifyGoogleIdToken(idToken, { ...expected, jwks }),
  };
  return { provider, state };
}

export type TestApp = ReturnType<typeof createApp>;

export const call = (app: TestApp, path: string, init: RequestInit = {}, ip = '203.0.113.1') =>
  app.request(
    path,
    { ...init, headers: { 'cf-connecting-ip': ip, ...(init.headers ?? {}) } },
    env,
  );

export const postJson = (app: TestApp, path: string, body: unknown, ip?: string, headers = {}) =>
  call(
    app,
    path,
    { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } },
    ip,
  );

// Drives the browser half of the flow: start -> Google -> callback -> loopback redirect.
export async function browserSignIn(
  app: TestApp,
  google: Awaited<ReturnType<typeof fakeGoogle>>,
  ip = '203.0.113.1',
) {
  const verifier = randomToken();
  const desktopState = randomToken();
  const start = await call(
    app,
    `/api/v1/auth/google/start?${new URLSearchParams({
      challenge: await sha256(verifier),
      state: desktopState,
      port: '51515',
    })}`,
    {},
    ip,
  );
  const authorize = new URL(start.headers.get('location') ?? '');
  google.state.nonce = authorize.searchParams.get('nonce') ?? '';
  const callback = await call(
    app,
    `/api/v1/auth/google/callback?${new URLSearchParams({
      state: authorize.searchParams.get('state') ?? '',
      code: 'google-auth-code',
    })}`,
    {},
    ip,
  );
  const loopback = new URL(callback.headers.get('location') ?? '');
  return { start, authorize, callback, loopback, verifier, desktopState };
}

export async function signIn(app: TestApp, google: Awaited<ReturnType<typeof fakeGoogle>>, ip?: string) {
  const { loopback, verifier } = await browserSignIn(app, google, ip);
  const res = await postJson(
    app,
    '/api/v1/auth/desktop/exchange',
    { code: loopback.searchParams.get('code'), code_verifier: verifier, device_name: 'Test device' },
    ip,
  );
  return (await res.json()) as {
    access_token: string;
    refresh_token: string;
    account: { id: string; email: string };
  };
}
