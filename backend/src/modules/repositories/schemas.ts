import { z } from 'zod';
import { cursor } from '../../lib/cursor';

const NAME = /^[A-Za-z0-9._-]+$/;

// Twin of the desktop's folder-name rules in src/shared/repos.ts, so a remote name is always a valid folder.
export const repositoryName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(NAME)
  .refine((name) => !name.startsWith('.') && !/\.(git|lock)$/i.test(name))
  .refine((name) => !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name));

const description = z
  .string()
  .trim()
  .max(280)
  .regex(/^[^\r\n\0]*$/)
  .nullable()
  .optional();

export const createBody = z.object({ name: repositoryName, description }).strict();

export const updateBody = z
  .object({ name: repositoryName.optional(), description })
  .strict()
  .refine((body) => body.name !== undefined || body.description !== undefined);

export const createHeaders = z.object({ 'idempotency-key': z.uuid().optional() });

const limit = z.coerce.number().int().min(1).max(50).default(20);

// Each sort has its own cursor shape, so a cursor from one sort is rejected by the other.
export const listQuery = z.union([
  z.object({
    sort: z.literal('updated').default('updated'),
    limit,
    cursor: cursor(z.tuple([z.number().int().nonnegative(), z.uuid()])).optional(),
  }),
  z.object({
    sort: z.literal('name'),
    limit,
    cursor: cursor(z.tuple([z.string().max(100).regex(NAME), z.uuid()])).optional(),
  }),
]);

export const repositoryParams = z.object({ id: z.uuid() });
