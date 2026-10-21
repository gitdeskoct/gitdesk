import { z } from 'zod';

// 32 random bytes, base64url without padding.
const token43 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const startQuery = z.object({
  challenge: token43,
  state: token43,
  port: z.coerce.number().int().min(1024).max(65535),
});

export const callbackQuery = z.object({
  state: z.string().max(256).optional(),
  code: z.string().max(2048).optional(),
  error: z.string().max(256).optional(),
});

export const exchangeBody = z.object({
  code: token43,
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  device_name: z.string().trim().min(1).max(100),
});

export const refreshBody = z.object({ refresh_token: token43 });

export const sessionParams = z.object({ id: z.uuid() });
