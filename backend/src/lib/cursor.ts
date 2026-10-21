import { z, type ZodType } from 'zod';

// Keyset cursors are base64url JSON of the last row's sort key and id. Opaque to the client.
export const encodeCursor = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A cursor that doesn't decode to `shape` fails validation instead of silently restarting at page 1.
export const cursor = <T extends ZodType>(shape: T) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,300}$/)
    .transform((value, ctx): z.output<T> => {
      try {
        const parsed = shape.safeParse(JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))));
        if (parsed.success) return parsed.data;
      } catch {
        // Falls through to the issue below.
      }
      ctx.addIssue({ code: 'custom', message: 'Invalid cursor.' });
      return z.NEVER;
    });
