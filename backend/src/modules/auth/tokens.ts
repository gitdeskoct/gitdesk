import { SignJWT, base64url, jwtVerify } from 'jose';
import type { AuthContext } from '../../env';

export const ACCESS_TOKEN_TTL_SECONDS = 600;
const AUDIENCE = 'gitdesk-desktop';

type TokenEnv = Pick<CloudflareBindings, 'JWT_SIGNING_KEY' | 'PUBLIC_ORIGIN'>;

function signingKey(env: TokenEnv): Uint8Array {
  const key = base64url.decode(env.JWT_SIGNING_KEY);
  if (key.byteLength < 32) throw new Error('JWT_SIGNING_KEY must be at least 32 bytes');
  return key;
}

export const signAccessToken = (env: TokenEnv, auth: AuthContext): Promise<string> =>
  new SignJWT({ sid: auth.sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(env.PUBLIC_ORIGIN)
    .setAudience(AUDIENCE)
    .setSubject(auth.accountId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(signingKey(env));

export async function verifyAccessToken(
  env: TokenEnv,
  token: string,
): Promise<AuthContext> {
  const { payload } = await jwtVerify(token, signingKey(env), {
    algorithms: ['HS256'],
    issuer: env.PUBLIC_ORIGIN,
    audience: AUDIENCE,
    requiredClaims: ['sub', 'sid', 'exp'],
  });
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
    throw new Error('malformed access token');
  }
  return { accountId: payload.sub, sessionId: payload.sid };
}
