import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { organization } from 'better-auth/plugins/organization'
import { db } from '../db/index.js'
import * as schema from '../db/schema.js'
import { env } from '../env.js'
import { logger } from '../logger.js'
import { ac, roles } from './access.js'

/**
 * Better Auth owns identity: users, sessions, the single organization, its
 * members, and invitations. It does NOT own tenancy — which clients a given
 * member may see is `client_access` plus the RLS policies.
 *
 * Keeping that boundary sharp matters. Auth answers "who are you and are you
 * staff"; Postgres answers "which rows may you see". Blurring them is how
 * multi-tenant apps end up with a `where` clause as their only defense.
 */
export const auth = betterAuth({
  baseURL: env.APP_URL,
  secret: env.BETTER_AUTH_SECRET,

  database: drizzleAdapter(db, {
    provider: 'pg',
    schema,
  }),

  emailAndPassword: {
    enabled: true,
    // Seats are invited, never self-served — the cap is 10 and she decides who
    // holds them. An open sign-up endpoint would let anyone mint a member row.
    disableSignUp: true,
    minPasswordLength: 10,
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh the expiry at most once a day
  },

  advanced: {
    cookiePrefix: 'bd',
    // Secure cookies require HTTPS. On the bare-IP fallback ingress this must
    // stay false or every login silently fails to persist — see env.ts.
    useSecureCookies: env.COOKIE_SECURE,
    defaultCookieAttributes: {
      httpOnly: true,
      // Lax, not Strict: Strict drops the cookie on inbound navigation from an
      // email client, which would break the invitation links (and, in v1.2,
      // the magic review links) that those emails exist to deliver.
      sameSite: 'lax',
    },
  },

  rateLimit: {
    enabled: true,
    window: 60,
    max: 60,
    customRules: {
      // Brute-force protection on the one endpoint that accepts a password.
      // fail2ban runs on VPS4 but cannot see application-level auth failures.
      '/sign-in/email': { window: 900, max: 5 },
      '/organization/accept-invitation': { window: 900, max: 10 },
    },
  },

  plugins: [
    organization({
      ac,
      roles,
      // One organization, created once by the bootstrap script. Nobody makes
      // more; a second org would silently partition the seat count.
      allowUserToCreateOrganization: false,
      creatorRole: 'owner',
      // The seat cap she asked for, enforced by the plugin rather than by a
      // check we have to remember to call at every invitation site.
      membershipLimit: env.MAX_SEATS,
      invitationExpiresIn: 60 * 60 * 24 * 14, // 14 days
      async sendInvitationEmail(data) {
        // v1.1 sends this through Resend. Until then invitations are copyable
        // links: the API returns the URL and the operator passes it on. Logged
        // at info so it is recoverable from journalctl if the UI is closed.
        logger.info(
          { email: data.email, invitationId: data.id, role: data.role },
          'invitation created — deliver this link manually until email lands'
        )
      },
    }),
  ],

  trustedOrigins: [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://portal.hackdojob.com',
  ],
})

export type Auth = typeof auth
