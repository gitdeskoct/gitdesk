import { base64url } from 'jose';

const encoder = new TextEncoder();

export const randomToken = (bytes = 32): string =>
  base64url.encode(crypto.getRandomValues(new Uint8Array(bytes)));

export const sha256 = async (value: string): Promise<string> =>
  base64url.encode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
  );

// Hash both sides to a fixed length first so the comparison leaks neither content nor length.
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
