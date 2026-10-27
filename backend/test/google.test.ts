import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, verifyGoogleIdToken } from '../src/modules/auth/google';
import { CLIENT_ID, googleKeys } from './helpers';

const claims = {
  sub: 'subject',
  email: 'person@example.com',
  email_verified: true,
  name: 'Person',
  nonce: 'expected-nonce',
};

describe('verifyGoogleIdToken', async () => {
  const { jwks, sign } = await googleKeys();
  const verify = (token: string) =>
    verifyGoogleIdToken(token, { clientId: CLIENT_ID, nonce: 'expected-nonce', jwks });

  it('accepts a valid token', async () => {
    await expect(verify(await sign(claims))).resolves.toMatchObject({ subject: 'subject' });
  });

  describe('buildAuthorizeUrl', () => {
    it('normalizes OAuth client and callback values', () => {
      const url = new URL(
        buildAuthorizeUrl({
          clientId: ' client.apps.googleusercontent.com ',
          redirectUri: ' https://gitdesk.app/api/v1/auth/google/callback ',
          state: 'state',
          nonce: 'nonce',
          codeChallenge: 'challenge',
        }),
      );

      expect(url.searchParams.get('client_id')).toBe('client.apps.googleusercontent.com');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://gitdesk.app/api/v1/auth/google/callback',
      );
    });
  });

  it('accepts the issuer without scheme', async () => {
    await expect(verify(await sign(claims, { iss: 'accounts.google.com' }))).resolves.toBeTruthy();
  });

  it.each([
    ['issuer', () => sign(claims, { iss: 'https://evil.example.com' })],
    ['audience', () => sign(claims, { aud: 'someone-else' })],
    ['expiry', () => sign(claims, { exp: '-1m' })],
    ['nonce', () => sign({ ...claims, nonce: 'other' })],
    ['unverified email', () => sign({ ...claims, email_verified: false })],
  ])('rejects a bad %s', async (_label, make) => {
    await expect(verify(await make())).rejects.toMatchObject({ code: 'AUTH_PROVIDER_ERROR' });
  });

  it('rejects a token signed by another key', async () => {
    const other = await googleKeys();
    await expect(verify(await other.sign(claims))).rejects.toMatchObject({
      code: 'AUTH_PROVIDER_ERROR',
    });
  });
});
