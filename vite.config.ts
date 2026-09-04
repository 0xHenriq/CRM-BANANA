/// <reference types="vitest/config" />
import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { playwright } from '@vitest/browser-playwright'

const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:4300'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // In development Vite serves the SPA and forwards the API to the Hono
    // process (npm run dev:api). In production Caddy plays this role, so the
    // frontend only ever talks to same-origin /api — no CORS, and session
    // cookies work identically in both environments.
    //
    // The target is overridable so a SECOND dev server can be pointed at a
    // second API — the `:4399` against `bd_portal_test` that this project's
    // tool matrix already recommends for exercising routes without touching
    // production. Without this the only way to look at a UI change in a
    // browser was to look at it against the live agency's data, because
    // `npm run dev` and `npm run dev:api` are hardcoded to each other.
    //
    //   VITE_API_TARGET=http://127.0.0.1:4399 npx vite --port 5174
    //
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/healthz': { target: apiTarget, changeOrigin: false },
    },
  },
  test: {
    // Component tests only. Server tests run in Node under
    // vitest.server.config.ts and would fail immediately in a browser.
    include: ['src/**/*.test.{ts,tsx}'],
    silent: 'passed-only',
    unstubEnvs: true,
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
    coverage: {
      // include: ['src/**/*.{js,jsx,ts,tsx}'], // Uncomment to expand the report to all src/**/* so untested modules appear as 0% coverage.
      exclude: [
        'src/components/ui/**',
        'src/assets/**',
        'src/tanstack-table.d.ts',
        'src/routeTree.gen.ts',
        'src/test-utils/**',
        'src/routes/**',
      ],
    },
  },
})
