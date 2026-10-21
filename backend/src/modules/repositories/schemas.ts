import { z } from 'zod';

// The same rules the desktop applies to a folder name, so a remote name is always a valid folder.
export const repositoryName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((name) => !name.startsWith('.') && !/\.(git|lock)$/i.test(name));

export const createBody = z
  .object({
    name: repositoryName,
    description: z
      .string()
      .trim()
      .max(280)
      .regex(/^[^\r\n\0]*$/)
      .nullable()
      .optional(),
  })
  .strict();

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .optional(),
});

export const repositoryParams = z.object({ id: z.uuid() });
