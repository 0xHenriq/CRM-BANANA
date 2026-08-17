import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { env } from './env.js'
import { logger } from './logger.js'
import { db, closeDb } from './db/index.js'

const app = new Hono()

// Request logging with a per-request id, so a client's "it broke" can be traced
// to a single line in journalctl.
let requestSeq = 0
app.use('*', async (c, next) => {
  const started = performance.now()
  const id = `${Date.now().toString(36)}-${(requestSeq++).toString(36)}`
  c.set('requestId' as never, id as never)
  await next()
  logger.info(
    {
      id,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    },
    'request'
  )
})

/**
 * Liveness + readiness in one. Checks that Postgres answers *and* that the
 * app role can read a real table — a plain `SELECT 1` would stay green while
 * every tenant query failed on permissions.
 */
app.get('/healthz', async (c) => {
  const checks: Record<string, 'ok' | string> = {}
  let healthy = true

  try {
    await db.execute(sql`select 1 from system_meta limit 1`)
    checks.database = 'ok'
  } catch (err) {
    healthy = false
    checks.database = err instanceof Error ? err.message : 'unknown error'
  }

  checks.uploads = existsSync(env.UPLOAD_DIR) ? 'ok' : 'missing upload dir'
  if (checks.uploads !== 'ok') healthy = false

  return c.json(
    { status: healthy ? 'ok' : 'degraded', checks },
    healthy ? 200 : 503
  )
})

app.get('/api/version', (c) =>
  c.json({ name: 'bd-portal', env: env.NODE_ENV })
)

// Phase 2+ mounts /api/auth, /api/clients, /api/portal/* here.

app.notFound((c) =>
  c.req.path.startsWith('/api') || c.req.path === '/healthz'
    ? c.json({ error: 'Not found' }, 404)
    : c.notFound()
)

app.onError((err, c) => {
  logger.error({ err, path: c.req.path }, 'unhandled error')
  // Never leak internals to the client; the request id is the join key.
  return c.json({ error: 'Internal server error' }, 500)
})

/**
 * In production this process also serves the built SPA, so a single systemd
 * unit is the whole application. In development Vite serves the frontend and
 * proxies /api here, so this branch stays off.
 */
if (env.NODE_ENV === 'production' && existsSync('./dist')) {
  app.use('/assets/*', serveStatic({ root: './dist' }))
  app.use('/images/*', serveStatic({ root: './dist' }))
  app.get('*', serveStatic({ path: './dist/index.html' }))
}

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info(
    { port: info.port, env: env.NODE_ENV },
    'bd-portal api listening'
  )
})

// systemd sends SIGTERM on restart; drain rather than drop in-flight requests.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down')
    server.close(async () => {
      await closeDb()
      process.exit(0)
    })
  })
}

export { app }
