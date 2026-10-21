import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { ApiError } from '../../lib/errors';

// Values from https://accounts.google.com/.well-known/openid-configuration
export const GOOGLE = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
} as const;

export type GoogleProfile = {
  subject: string;
  email: string;
  name: string;
  picture: string | null;
};

export type ExchangeInput = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
};

export interface GoogleProvider {
  exchangeCode(input: ExchangeInput): Promise<string>;
  verifyIdToken(
    idToken: string,
    expected: { clientId: string; nonce: string },
  ): Promise<GoogleProfile>;
}

export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE.authorize);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

const idTokenClaims = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().email().max(320),
  email_verified: z.union([z.literal(true), z.literal('true')]),
  nonce: z.string(),
  name: z.string().max(200).optional(),
  picture: z.string().url().startsWith('https://').max(2048).optional(),
});

export async function verifyGoogleIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string; jwks: JWTVerifyGetKey },
): Promise<GoogleProfile> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, expected.jwks, {
      algorithms: ['RS256'],
      issuer: [...GOOGLE.issuers],
      audience: expected.clientId,
      requiredClaims: ['sub', 'exp', 'iat'],
    }));
  } catch {
    throw new ApiError('AUTH_PROVIDER_ERROR', 'Google sign-in could not be verified.');
  }
  const claims = idTokenClaims.safeParse(payload);
  if (!claims.success || claims.data.nonce !== expected.nonce) {
    throw new ApiError('AUTH_PROVIDER_ERROR', 'Google sign-in could not be verified.');
  }
  const { sub, email, name, picture } = claims.data;
  return { subject: sub, email, name: name ?? email, picture: picture ?? null };
}

const tokenResponse = z.object({ id_token: z.string().min(1) });

export const googleProvider: GoogleProvider = {
  async exchangeCode(input) {
    const res = await fetch(GOOGLE.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }),
    });
    const body = res.ok ? tokenResponse.safeParse(await res.json()) : null;
    if (!body?.success) {
      throw new ApiError('AUTH_PROVIDER_ERROR', 'Google rejected the sign-in.');
    }
    return body.data.id_token;
  },
  // Built per call: a shared remote JWKS would share in-flight fetches across requests.
  verifyIdToken: (idToken, expected) =>
    verifyGoogleIdToken(idToken, {
      ...expected,
      jwks: createRemoteJWKSet(new URL(GOOGLE.jwks)),
    }),
};
