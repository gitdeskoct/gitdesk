import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomToken = (): string => randomBytes(32).toString('base64url');

// RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))).
export const challengeFor = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');

export const safeEqual = (a: string, b: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
