/**
 * Thin API client.
 *
 * Same-origin `/api` in both environments — Vite proxies it in dev, Caddy in
 * production — so `credentials: 'include'` carries the httpOnly session cookie
 * and there is no token for this layer to hold.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown }
): Promise<T> {
  const { json, ...rest } = init ?? {}
  const res = await fetch(`/api${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...rest.headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })

  if (!res.ok) {
    // Surface the server's message where there is one — it is written for a
    // human ("All 10 seats are taken…"), and replacing it with "Request
    // failed" throws away the only useful part.
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, json?: unknown) =>
    request<T>(path, { method: 'POST', json }),
  patch: <T>(path: string, json?: unknown) =>
    request<T>(path, { method: 'PATCH', json }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

/* ------------------------------------------------------------------ types */

export type ClientStatus = 'lead' | 'proposal' | 'active' | 'paused' | 'churned'

export type DealStage =
  | 'lead'
  | 'contacted'
  | 'proposal'
  | 'negotiation'
  | 'won'
  | 'lost'

export type ClientSummary = {
  id: string
  name: string
  slug: string
  status: ClientStatus
  portalEnabled: boolean
  createdAt: string
  contactCount: number
  openTaskCount: number
  awaitingReviewCount: number
  seatCount: number
}

export type Contact = {
  id: string
  clientId: string
  name: string
  email: string | null
  phone: string | null
  title: string | null
  isPrimary: boolean
}

export type Deal = {
  id: string
  clientId: string
  title: string
  /** numeric(12,2) arrives as a string; never parseFloat it for storage. */
  value: string | null
  currency: string
  stage: DealStage
  expectedClose: string | null
  updatedAt: string
}

export type DealWithClient = Deal & { clientName: string }

export type Activity = {
  id: string
  kind: 'note' | 'call' | 'email' | 'meeting' | 'status_change'
  body: string | null
  entityType: string
  occurredAt: string
  actorName: string | null
}

export type ClientDetail = {
  client: {
    id: string
    name: string
    slug: string
    status: ClientStatus
    brandColor: string | null
    portalEnabled: boolean
    createdAt: string
  }
  contacts: Contact[]
  deals: Deal[]
  timeline: Activity[]
  seats: { userId: string; email: string; name: string }[]
}

/** Formats a numeric(12,2) string for display without float round-tripping. */
export function formatMoney(value: string | null, currency = 'GBP'): string {
  if (value === null) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(n)
}
