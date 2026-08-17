import { pino } from 'pino'
import { env } from './env.js'

export const logger = pino({
  level: env.LOG_LEVEL,
  // Pretty output locally; raw JSON in production so journalctl and any future
  // log shipper get structured records rather than ANSI escapes.
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'password',
      '*.password',
    ],
    censor: '[redacted]',
  },
})
