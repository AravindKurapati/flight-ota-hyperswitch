import 'server-only';
import { z } from 'zod';

const schema = z.object({
  HYPERSWITCH_API_KEY: z.string().min(1),
  HYPERSWITCH_PUBLISHABLE_KEY: z.string().startsWith('pk_snd_'),
  HYPERSWITCH_PROFILE_ID: z.string().min(1),
  HYPERSWITCH_WEBHOOK_SECRET: z.string(),
  DATABASE_URL: z.string().url(),
  APP_BASE_URL: z.string().url(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(`Invalid or missing environment variables: ${missing}`);
}

export const env = Object.freeze(parsed.data);
