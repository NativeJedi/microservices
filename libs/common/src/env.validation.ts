import { z } from 'zod';

export const commonEnvValidationRules = {
  MONGODB_URI: z
    .string()
    .refine(
      (uri) => uri.startsWith('mongodb://') || uri.startsWith('mongodb+srv://'),
      'must start with mongodb:// or mongodb+srv://',
    ),
  PORT: z.coerce.number().int().positive().default(3000),
};
