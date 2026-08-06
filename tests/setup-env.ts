// Populates process.env with syntactically valid dummy values so that
// lib/env.ts (which throws at import time) can be imported under Vitest
// without a real .env file present.
process.env.HYPERSWITCH_API_KEY ??= 'snd_test_dummy_api_key';
process.env.HYPERSWITCH_PUBLISHABLE_KEY ??= 'pk_snd_test_dummy_publishable_key';
process.env.HYPERSWITCH_PROFILE_ID ??= 'pro_test_dummy_profile_id';
process.env.HYPERSWITCH_WEBHOOK_SECRET ??= 'whsec_test_dummy_secret';
process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/testdb?sslmode=require';
process.env.APP_BASE_URL ??= 'https://example-test.vercel.app';
