import { defineConfig } from 'vitest/config'

/**
 * Server-side tests run in Node, not the browser project used for components.
 * Kept as a separate config so `npm test` (components) and
 * `npm run test:isolation` (tenancy) never contend for the same environment.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts'],
    // Every spec truncates and reseeds the same database, so they must not
    // interleave. Correctness over wall-clock here.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
