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
  // Read the sign off the string, not the parsed number: Number('-0') is -0,
  // and `-0 < 0` is false, so '-0.50' came back as +50 pence. Nothing produces
  // negative values today (the API rejects them), but a sign flip inside a
  // money helper is exactly the bug that surfaces the day credit notes land.
  const negative = value.trimStart().startsWith('-')
  const [whole, frac = ''] = value.split('.')
  const pence = Number(`${frac}00`.slice(0, 2))
  const units = Math.abs(Number(whole))
  if (!Number.isFinite(units) || !Number.isFinite(pence)) return 0
  const total = units * 100 + pence
  return negative ? -total : total
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

/* ------------------------------------------------------------------ portal */

export type PortalLink = {
  id: string
  clientId: string
  label: string
  url: string
  icon: string | null
  sortOrder: number
}

export type PortalFile = {
  id: string
  clientId: string
  name: string
  storageKey: string | null
  mime: string | null
  sizeBytes: number | null
  externalUrl: string | null
  sortOrder: number
}

export type PortalTask = {
  id: string
  clientId: string
  title: string
  done: boolean
  dueDate: string | null
  assigneeId: string | null
  /** False marks internal work; clients never receive those rows at all. */
  visibleToClient: boolean
  sortOrder: number
}

export type NoticePost = {
  id: string
  body: string
  createdAt: string
  parentId: string | null
  authorId: string | null
  authorName: string | null
}

export type PortalWorkspace = {
  client: {
    id: string
    name: string
    brandColor: string | null
    portalEnabled: boolean
  }
  links: PortalLink[]
  files: PortalFile[]
  tasks: PortalTask[]
  notices: NoticePost[]
}

/* ----------------------------------------------------------------- content */

export const CONTENT_TYPES = [
  'video',
  'reel',
  'story',
  'graphic',
  'carousel',
] as const
export type ContentType = (typeof CONTENT_TYPES)[number]

export const CONTENT_STATUSES = [
  'idea',
  'in_progress',
  'ready_for_review',
  'approved',
  'scheduled',
  'published',
] as const
export type ContentStatus = (typeof CONTENT_STATUSES)[number]

/**
 * One record, three views.
 *
 * `scheduledAt === null` is an idea; a date puts the same row on the calendar;
 * its assets fill the feed preview. The prototype kept two stores that never
 * spoke, so approving an idea did nothing to the calendar.
 */
export type ContentItem = {
  id: string
  clientId: string
  title: string
  type: ContentType
  status: ContentStatus
  scheduledAt: string | null
  caption: string | null
  feedOrder: number | null
  visibleToClient: boolean
  createdAt: string
  updatedAt: string
}

export type ContentComment = {
  id: string
  body: string
  createdAt: string
  authorId: string | null
  authorName: string | null
}

export type ContentApproval = {
  id: string
  decision: 'approved' | 'changes_requested'
  note: string | null
  decidedAt: string
  actorName: string | null
}

export type ContentDetailAsset = {
  id: string
  kind: 'image' | 'video'
  durationMs: number | null
  width: number | null
  height: number | null
  sortOrder: number
}

export type ContentDetail = {
  item: ContentItem
  assets: ContentDetailAsset[]
  comments: ContentComment[]
  approvals: ContentApproval[]
}

/* ------------------------------------------------------------------- media */

export type ContentAsset = {
  id: string
  contentItemId: string
  kind: 'image' | 'video'
  thumbKey: string | null
  posterKey: string | null
  durationMs: number | null
  width: number | null
  height: number | null
  mime: string | null
  sizeBytes: number | null
}

export type MoodboardItem = {
  id: string
  clientId: string
  storageKey: string | null
  url: string | null
  caption: string | null
  sortOrder: number
}

export type FeedCell = {
  itemId: string
  title: string
  type: ContentType
  status: ContentStatus
  scheduledAt: string | null
  feedOrder: number | null
  assetId: string
  assetKind: 'image' | 'video'
}

/**
 * Media is streamed by the app, not served from a static path — the URL is an
 * endpoint that checks who is asking. `variant` picks the derived thumbnail or
 * video poster; both are webp and a fraction of the original.
 */
export function assetUrl(
  assetId: string,
  variant: 'original' | 'thumb' | 'poster' = 'original'
): string {
  return `/api/media/assets/${assetId}${variant === 'original' ? '' : `?variant=${variant}`}`
}

export function moodboardUrl(itemId: string): string {
  return `/api/media/moodboard/${itemId}`
}

/**
 * Uploads go as multipart, so this deliberately does not use `api.post` —
 * setting Content-Type by hand would omit the multipart boundary.
 */
export async function uploadMedia(
  file: File,
  opts: {
    clientId: string | null
    target: 'content' | 'moodboard' | 'file'
    contentItemId?: string
    caption?: string
  }
): Promise<unknown> {
  const form = new FormData()
  form.append('file', file)
  form.append('target', opts.target)
  if (opts.contentItemId) form.append('contentItemId', opts.contentItemId)
  if (opts.caption) form.append('caption', opts.caption)

  const qs = opts.clientId ? `?client=${opts.clientId}` : ''
  const res = await fetch(`/api/media/upload${qs}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(body?.error ?? `Upload failed (${res.status})`, res.status)
  }
  return res.json()
}

export type AwaitingItem = {
  id: string
  clientId: string
  clientName: string
  title: string
  type: ContentType
  scheduledAt: string | null
  updatedAt: string
}
