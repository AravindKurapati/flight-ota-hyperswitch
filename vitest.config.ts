import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // `server-only` throws by design when imported outside a React
      // Server Component. Alias it to a no-op stub so modules that start
      // with `import 'server-only'` (e.g. lib/env.ts) can be imported
      // under Vitest.
      'server-only': path.resolve(dirname, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: [path.resolve(dirname, 'tests/setup-env.ts')],
  },
});
