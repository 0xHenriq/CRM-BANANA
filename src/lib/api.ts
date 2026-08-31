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
    const body = (await res.json().catch(() => null)) as {
      error?: string
    } | null
    throw new ApiError(
      body?.error ?? `Request failed (${res.status})`,
      res.status
    )
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

/**
 * Client lifecycle, and the single client-side source of truth.
 *
 * A const array rather than a bare union type, for the same reason DEAL_STAGES
 * below is one: the vocabulary existed in five places — the Postgres enum, the
 * server's list, this type, and a hand-written copy in each of two screens —
 * and only a runtime array can be compared against the server's in a test.
 * See `client statuses` in server/__tests__/contract.test.ts.
 *
 * The words she READS are separate and deliberately different: see
 * CLIENT_LABEL in src/features/clients/status-pill.tsx, where `paused` renders
 * as "Completed" and `churned` as "Deleted".
 */
export const CLIENT_STATUSES = [
  'lead',
  'proposal',
  'active',
  'paused',
  'churned',
] as const

export type ClientStatus = (typeof CLIENT_STATUSES)[number]

/**
 * Display order for the grouped Clients list, which is NOT the enum order.
 *
 * The enum runs lead -> churned because that is the lifecycle. This runs by
 * how much attention each state deserves on a Monday morning: the clients she
 * is delivering for, then the ones she is chasing, then the dormant ones she
 * only needs to see to know they are still there.
 *
 * It must contain every status exactly once. The Clients page renders one
 * group per entry, so a status missing from here does not fall to the bottom
 * of the page — those clients disappear from it entirely. A contract test
 * asserts it is a permutation.
 */
export const CLIENT_STATUS_ORDER: readonly ClientStatus[] = [
  'active',
  'proposal',
  'lead',
  'paused',
  'churned',
]

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

/**
 * What POST /seats/invite did.
 *
 * Two genuinely different outcomes, so the caller is made to tell them apart:
 * a brand-new address gets an invitation and a link to pass on; an address
 * that already has an account is granted access there and then, and there is
 * no link because there is nothing to accept. Rendering the second as the
 * first would put the word "undefined" on her clipboard.
 */
export type InviteResult =
  | { kind: 'invited'; email: string; inviteUrl: string }
  | {
      kind: 'granted'
      email: string
      workspacesGranted: number
      restored?: boolean
    }

/** A share link as the staff list sees it. The token is never among these. */
export type ShareLink = {
  id: string
  scope: 'content_item' | 'feed'
  contentItemId: string | null
  expiresAt: string
  revokedAt: string | null
  lastUsedAt: string | null
  useCount: number
  createdAt: string
}

/**
 * Can this link still be used?
 *
 * The browser's copy of the server's `isLinkUsable`, because the staff list
 * has to label every link without asking. Bound to the server's in
 * contract.test.ts over the same inputs — two copies of one rule drift, and
 * this one decides whether she thinks a client can still reach a post.
 */
export function isLinkUsable(
  link: { expiresAt: string | Date; revokedAt: string | Date | null },
  now: Date
): boolean {
  if (link.revokedAt) return false
  return new Date(link.expiresAt).getTime() > now.getTime()
}

/** Why a link is not usable, for the badge next to it. */
export function linkState(
  link: { expiresAt: string; revokedAt: string | null },
  now: Date
): 'live' | 'revoked' | 'expired' {
  if (link.revokedAt) return 'revoked'
  return isLinkUsable(link, now) ? 'live' : 'expired'
}

export type ClientSummary = {
  id: string
  name: string
  slug: string
  status: ClientStatus
  portalEnabled: boolean
  logoKey: string | null
  brandColor: string | null
  archivedAt: string | null
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

export const PAYMENT_STATUSES = ['none', 'awaiting', 'paid'] as const
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

/**
 * What the card actually shows, which is not what is stored.
 *
 * `overdue` is derived, never persisted: it is `awaiting` with a due date that
 * has passed. Storing it would mean something had to run at midnight to keep
 * it true, and a status that goes stale is worse than no status.
 */
export type PaymentState = PaymentStatus | 'overdue'

/**
 * Is this 'YYYY-MM-DD' before today, in the reader's own calendar?
 *
 * Deliberately not `new Date(iso) < new Date()`: 'YYYY-MM-DD' parses as UTC
 * midnight, which calls a date overdue a day early west of Greenwich and a day
 * late east of it. Two features now turn something red on this comparison —
 * deal payment state and invoices — so it lives in one place rather than being
 * written twice and drifting.
 */
export function isPastDate(iso: string | null | undefined): boolean {
  if (!iso) return false
  const [y, m, d] = iso.split('-').map(Number)
  const then = new Date(y, m - 1, d)
  const now = new Date()
  return then < new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/**
 * A post that has sailed past its own posting date with nobody having said yes.
 *
 * Derived, never stored — the same rule as overdue payments and overdue
 * invoices. A stored "approval overdue" flag would need something running at
 * midnight to stay true, and a status that goes stale is worse than no status.
 *
 * `ready_for_review` is the only status this can apply to, and that is the
 * whole rule rather than a shortcut. It is the one state meaning "sent to the
 * client, nobody has decided": approving moves the row to `scheduled` or
 * `approved`, and requesting changes moves it to `in_progress`, so any other
 * status has already had its answer. An `approved` post sitting past its date
 * is a different failure — nobody published it — and calling that an approval
 * problem would send her chasing a client who already replied.
 *
 * No date means no deadline, so an undated item waiting for review is never
 * overdue. `isPastDate` returns false for null, which is exactly that.
 */
export function isApprovalOverdue(item: {
  status: ContentStatus
  scheduledAt: string | null
}): boolean {
  return item.status === 'ready_for_review' && isPastDate(item.scheduledAt)
}

export function paymentState(deal: {
  paymentStatus: PaymentStatus
  paymentDue: string | null
}): PaymentState {
  if (deal.paymentStatus !== 'awaiting') return deal.paymentStatus
  return isPastDate(deal.paymentDue) ? 'overdue' : 'awaiting'
}

/* ---------------------------------------------------------------- invoices */

export const INVOICE_STATUSES = ['draft', 'sent', 'void'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

/**
 * What an invoice actually IS, which is more than what is stored.
 *
 * Only draft/sent/void are decisions she makes. Paid, part paid and overdue
 * are facts about the receipts against it and today's date, so they are worked
 * out here and never written down — an invoice goes red on its own the morning
 * it is late, rather than waiting for someone to remember to mark it.
 */
export type InvoiceState =
  'draft' | 'sent' | 'part_paid' | 'paid' | 'overdue' | 'void'

export type Invoice = {
  id: string
  clientId: string
  clientName: string
  dealId: string | null
  number: string
  status: InvoiceStatus
  /** Integer pence. Never parseFloat this; use formatPence to show it. */
  amountPence: number
  paidPence: number
  currency: string
  description: string | null
  issuedOn: string | null
  dueOn: string | null
  notes: string | null
  createdAt: string
  /**
   * The attached document, if there is one.
   *
   * The same `files` row the File Folder lists — one set of bytes, read from
   * two places, so deleting it in one cannot leave a ghost in the other. A
   * document on a DRAFT invoice is invisible to the client, because the row
   * inherits the invoice's own visibility (migration 0018).
   */
  attachmentId: string | null
  attachmentName: string | null
}

/** A payment received. This row is the receipt. */
export type InvoicePayment = {
  id: string
  invoiceId: string
  receiptNumber: string
  amountPence: number
  paidOn: string
  method: string | null
  reference: string | null
  createdAt: string
}

export function invoiceState(invoice: {
  status: InvoiceStatus
  amountPence: number
  paidPence: number
  dueOn: string | null
}): InvoiceState {
  if (invoice.status === 'void') return 'void'
  if (invoice.status === 'draft') return 'draft'
  if (invoice.paidPence >= invoice.amountPence) return 'paid'
  // Overdue outranks part paid: a half-settled invoice that is late is late,
  // and that is the fact she needs to act on.
  if (isPastDate(invoice.dueOn)) return 'overdue'
  return invoice.paidPence > 0 ? 'part_paid' : 'sent'
}

/** What is still owed. Never negative — overpayment is refused server-side. */
export function outstandingPence(invoice: {
  status: InvoiceStatus
  amountPence: number
  paidPence: number
}): number {
  if (invoice.status === 'draft' || invoice.status === 'void') return 0
  return Math.max(0, invoice.amountPence - invoice.paidPence)
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
  paymentStatus: PaymentStatus
  paymentDue: string | null
  paidAt: string | null
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
    /** Mirrors brandColors[0]. Read the palette, write the palette. */
    brandColor: string | null
    /** Five slots — two primary, three secondary. '' is an unset slot, and an
     *  empty array is a palette that has never been touched. */
    brandColors: string[]
    logoKey: string | null
    brief: string | null
    toneOfVoice: string | null
    portalEnabled: boolean
    archivedAt: string | null
    createdAt: string
    updatedAt: string
  }
  contacts: Contact[]
  deals: Deal[]
  timeline: Activity[]
  seats: { userId: string; email: string; name: string }[]
  /** Invitations for this workspace that nobody has accepted yet. */
  pendingInvites: { id: string; email: string; expiresAt: string }[]
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
    logoKey: string | null
    toneOfVoice: string | null
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
  /** 'HH:MM:SS' as Postgres returns it; render with `formatTime`. */
  scheduledTime: string | null
  caption: string | null
  hashtags: string[]
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
  /** True when a share link made the decision, which has no actor to name. */
  viaShareLink: boolean
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
  /**
   * 'HH:MM:SS' as Postgres returns it, or null.
   *
   * The feed endpoint has always selected this (see the `scheduled_time`
   * column in the /api/media/feed query) and this type simply never declared
   * it, so it arrived over the wire and was invisible to the compiler.
   */
  scheduledTime: string | null
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
 * A File Folder download.
 *
 * The server answers this with `Content-Disposition: attachment`, so the
 * browser saves it under its original name rather than rendering it — these
 * are arbitrary uploaded documents served from our own origin, and rendering
 * one inline would run it there.
 */
export function fileUrl(fileId: string): string {
  return `/api/media/files/${fileId}`
}

/**
 * A client's logo.
 *
 * The path carries no key, so it cannot be used to read arbitrary storage —
 * the server looks the key up on the row and answers only if the caller can
 * see that client. `logoKey` rides along as a cache-buster: the URL is
 * otherwise identical after a replacement, and she would upload a new mark and
 * keep seeing the old one until a hard refresh.
 */
export function logoUrl(clientId: string, logoKey: string): string {
  const version = logoKey.slice(logoKey.lastIndexOf('/') + 1)
  return `/api/media/clients/${clientId}/logo?v=${encodeURIComponent(version)}`
}

/**
 * A 'YYYY-MM-DD' column as a short, readable day: '1 Sep'.
 *
 * Two decisions, both deliberate.
 *
 * The date is read from its LOCAL parts and never through `new Date(iso)`: a
 * bare date string parses as UTC midnight, so it renders as the previous day
 * west of Greenwich and misreports an evening east of it. Same trap
 * `isPastDate` above exists to avoid.
 *
 * The month names are a fixed table rather than `toLocaleDateString`, which is
 * the usual way to do this and is wrong here for two reasons. Its output moves
 * with the ICU data built into whichever Node is running, so a test asserting
 * it passes on one machine and fails on another — this was found exactly that
 * way. And `en-GB` abbreviates September to "Sept", four characters, which is
 * a real problem in a feed cell a third of a grid wide.
 */
const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return ''
  const month = SHORT_MONTHS[m - 1]
  if (!month) return ''
  return `${d} ${month}`
}

/**
 * How many brand colours a client has. Two primary, three secondary.
 *
 * Bound to the server's `BRAND_COLOR_SLOTS` in contract.test.ts — the PATCH
 * schema requires exactly this many, so a UI that renders a different number
 * would 400 on every save.
 */
export const BRAND_COLOR_SLOTS = 5

/** The slot labels, in order. Index is the slot. */
export const BRAND_COLOR_ROLES = [
  'Primary 1',
  'Primary 2',
  'Secondary 1',
  'Secondary 2',
  'Secondary 3',
] as const

/**
 * What a person types, turned into what the server accepts, or null.
 *
 * A brand palette arrives from a brand guide as a list of hex codes, so the
 * field has to take a paste — and pasted hex comes with a hash or without one,
 * in three digits or six, in whatever case the guide used. Every one of those
 * is unambiguous, so rejecting them would be pedantry the person has to work
 * around by hand.
 *
 * Returns null for anything genuinely not a colour, including empty input, so
 * the caller has one thing to check. Output is always lowercase `#rrggbb`,
 * which is exactly what the server's regex accepts and what `<input
 * type="color">` reports — the same value from all three routes in, so a
 * colour picked and the same colour pasted compare equal.
 */
export function normaliseHex(input: string): string | null {
  const body = input.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(body)) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`
  }
  if (/^[0-9a-f]{6}$/.test(body)) return `#${body}`
  return null
}

/**
 * A client's palette as exactly BRAND_COLOR_SLOTS entries.
 *
 * Stored short — an empty array is every client who has never set one — and
 * read positionally, because the slots are named roles. One helper so the
 * card, the swatches and the save path cannot disagree about what slot 3 is.
 */
export function brandPalette(colors: string[] | null | undefined): string[] {
  return Array.from({ length: BRAND_COLOR_SLOTS }, (_, i) => colors?.[i] ?? '')
}

/**
 * A timestamp down to the calendar day it falls on where the reader is.
 *
 * `iso.slice(0, 10)` is the tempting one-liner and it is wrong: an ISO
 * timestamp is UTC, so 2026-09-14T23:30:00Z is the 15th in London and the
 * slice says the 14th. Built from local parts, like every other date in this
 * product.
 *
 * Returns 'YYYY-MM-DD', which is what `formatShortDate` and `isPastDate` both
 * take — so a timestamp column and a date column render identically rather
 * than one of them growing its own spelling of September.
 */
export function localDayOf(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 'HH:MM:SS' from Postgres down to the 'HH:MM' people read and type.
 *
 * Seconds are noise for a posting time and the picker does not offer them, so
 * showing them would imply a precision nobody set.
 */
export function formatTime(value: string | null | undefined): string {
  return value ? value.slice(0, 5) : ''
}

/** Human file size. Bytes are never the useful unit above about a kilobyte. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  // One decimal below 10 so "1.4 MB" does not read as "1 MB"; none above,
  // where the extra digit is noise.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export type AwaitingItem = {
  id: string
  clientId: string
  clientName: string
  title: string
  type: ContentType
  scheduledAt: string | null
  scheduledTime: string | null
  updatedAt: string
}
