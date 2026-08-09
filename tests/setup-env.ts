// Load .env first (if present) so DATABASE_URL points at the real sandbox
// database for integration tests. dotenv never overwrites a variable that
// is already set, so this is a no-op in environments (e.g. CI) that inject
// env vars directly.
import 'dotenv/config';

// The fallback below is not a real, reachable database. Exported so
// integration tests can detect "no real DATABASE_URL was configured" and
// skip themselves instead of failing against a Postgres that doesn't exist.
export const FALLBACK_DATABASE_URL = 'postgresql://user:pass@localhost:5432/testdb?sslmode=require';

// Populates process.env with syntactically valid dummy values so that
// lib/env.ts (which throws at import time) can be imported under Vitest
// without a real .env file present. Real values loaded above take
// precedence via `??=`.
process.env.HYPERSWITCH_API_KEY ??= 'snd_test_dummy_api_key';
process.env.HYPERSWITCH_PUBLISHABLE_KEY ??= 'pk_snd_test_dummy_publishable_key';
process.env.HYPERSWITCH_PROFILE_ID ??= 'pro_test_dummy_profile_id';
process.env.HYPERSWITCH_WEBHOOK_SECRET ??= 'whsec_test_dummy_secret';
process.env.DATABASE_URL ??= FALLBACK_DATABASE_URL;
process.env.APP_BASE_URL ??= 'https://example-test.vercel.app';
