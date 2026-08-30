import { z } from 'zod';

export const envSchema = z.object({
  MONGODB_URI: z
    .string()
    .refine(
      (uri) => uri.startsWith('mongodb://') || uri.startsWith('mongodb+srv://'),
      'must start with mongodb:// or mongodb+srv://',
    ),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;
