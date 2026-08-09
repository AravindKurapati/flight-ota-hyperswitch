import 'server-only';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { env } from '../lib/env';
import * as schema from './schema';

// The Node.js runtime has no global `WebSocket`, and the pooled driver needs
// one to hold sessions open for `SELECT ... FOR UPDATE` transactions.
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: env.DATABASE_URL });
export const db = drizzle(pool, { schema });
export * from './schema';
