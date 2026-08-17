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

/**
 * Board order, and the single client-side source of truth. The server has its
 * own list in routes/deals.ts; these must agree, and a mismatch shows up as a
 * 400 on the very first drag rather than anything subtle.
 */
export const DEAL_STAGES = [
  'lead',
  'contacted',
  'proposal',
  'negotiation',
  'won',
  'lost',
] as const

export type DealStage = (typeof DEAL_STAGES)[number]

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

/**
 * Deal values are numeric(12,2), carried as strings so they survive the round
 * trip exactly. These helpers keep them exact right up to the point of display.
 */

/** '2400.50' -> 240050. Integer pence: the only safe unit to do sums in. */
export function toPence(value: string | null | undefined): number {
  if (!value) return 0
  const [whole, frac = ''] = value.split('.')
  const pence = Number(`${frac}00`.slice(0, 2))
  const units = Number(whole)
  if (!Number.isFinite(units) || !Number.isFinite(pence)) return 0
  return units * 100 + (units < 0 ? -pence : pence)
}

export function sumPence(values: (string | null | undefined)[]): number {
  return values.reduce<number>((total, v) => total + toPence(v), 0)
}

/**
 * Formats integer pence for display.
 *
 * Pence are shown only when they are non-zero. Rounding them away made
 * £2,400.50 render as "£2,401" and £0.75 as "£1" — a deal value that does not
 * match the contract is worse than a slightly longer string.
 */
export function formatPence(pence: number, currency = 'GBP'): string {
  const hasFraction = pence % 100 !== 0
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: hasFraction ? 2 : 0,
  }).format(pence / 100)
}

export function formatMoney(value: string | null, currency = 'GBP'): string {
  if (value === null) return '—'
  return formatPence(toPence(value), currency)
}
