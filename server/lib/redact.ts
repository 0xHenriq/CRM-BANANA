/**
 * Keep share-link tokens out of the log.
 *
 * Its own module, with no imports and no side effects, because the request
 * logger in server/index.ts is not something a test can reach: importing that
 * file STARTS AN HTTP SERVER. contract.test.ts imported it to get at this
 * function and the suite then passed or failed on whether anything happened to
 * be holding port 4300 — a test result that depended on the developer's other
 * terminal. A pure function belongs where it can be tested without booting the
 * application.
 */

/**
 * A share-link path IS a live approval credential, and every request is
 * logged with its path. Without this a token would be written to journalctl in
 * the clear — both as `/api/share/<token>` and, in production, as
 * `/share/<token>`, because Hono serves the SPA and the browser asks for that
 * path first. Anyone with read access to the logs could then approve her
 * clients' posts.
 *
 * `/api/shares/...` is deliberately NOT redacted: that is the staff surface
 * and it carries link ids, which are not credentials. `\/share\/` must not
 * match `\/shares\/`.
 *
 * Caddy keeps its own access log outside this repo. It has to be checked
 * separately before the first real link is sent.
 */
export function redactPath(path: string): string {
  return path.replace(
    /^(\/api)?\/share\/[^/]+/,
    (m) => `${m.startsWith('/api') ? '/api' : ''}/share/[token]`
  )
}
