/**
 * Application schema.
 *
 * Two conventions hold everywhere and are load-bearing:
 *
 *  1. Every table holding tenant data carries `clientId` DIRECTLY — child
 *     tables included. An RLS policy that had to join upward to find its
 *     tenant would be slower and much easier to get subtly wrong.
 *  2. Nothing is queried outside `withTenant()`. There is no ambient current
 *     user; the transaction carries it.
 *
 * Note that Better Auth uses TEXT primary keys, so every reference to a user
 * is `text`, while our own ids are `uuid`.
 */
import { relations, sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { invitation, user } from './auth-schema.js'

export * from './auth-schema.js'

/* -------------------------------------------------------------------------
 * Vocabulary — hers, verbatim. Do not rename; these strings appear in the UI
 * and in her head. New values can be appended to a Postgres enum cheaply;
 * renaming one means a data migration and a retrained client.
 * ---------------------------------------------------------------------- */

export const clientStatus = pgEnum('client_status', [
  'lead',
  'proposal',
  'active',
  'paused',
  'churned',
])

export const dealStage = pgEnum('deal_stage', [
  'lead',
  'contacted',
  'proposal',
  'negotiation',
  'won',
  'lost',
])

/** Her five content types. */
export const contentType = pgEnum('content_type', [
  'video',
  'reel',
  'story',
  'graphic',
  'carousel',
])

/**
 * Her four statuses, plus two that the prototype implied but could not
 * express: a post that is approved and dated is `scheduled`, and one that has
 * gone out is `published`.
 */
export const contentStatus = pgEnum('content_status', [
  'idea',
  'in_progress',
  'ready_for_review',
  'approved',
  'scheduled',
  'published',
])

export const activityKind = pgEnum('activity_kind', [
  'note',
  'call',
  'email',
  'meeting',
  'status_change',
])

export const assetKind = pgEnum('asset_kind', ['image', 'video'])

export const approvalDecision = pgEnum('approval_decision', [
  'approved',
  'changes_requested',
])

/* -------------------------------------------------------------------------
 * Tenancy
 * ---------------------------------------------------------------------- */

export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    status: clientStatus('status').notNull().default('lead'),
    brandColor: text('brand_color'),
    logoKey: text('logo_key'),
    /** A lead has no portal. Set when she moves the client to `active`. */
    portalEnabled: boolean('portal_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('clients_status_idx').on(t.status)]
)

/**
 * Which client workspaces a client-role user may see.
 *
 * Staff bypass this via `app_is_staff()`. For everyone else it is the whole
 * of their visibility, and it is read inside the RLS policies themselves —
 * not by application code that could forget to consult it.
 */
export const clientAccess = pgTable(
  'client_access',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('client_access_user_client_idx').on(t.userId, t.clientId),
    index('client_access_user_idx').on(t.userId),
  ]
)

/* -------------------------------------------------------------------------
 * CRM — staff-only. A client-role session must never read any of these.
 * ---------------------------------------------------------------------- */

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    title: text('title'),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('contacts_client_idx').on(t.clientId)]
)

export const deals = pgTable(
  'deals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    value: numeric('value', { precision: 12, scale: 2 }),
    currency: text('currency').notNull().default('GBP'),
    stage: dealStage('stage').notNull().default('lead'),
    expectedClose: date('expected_close'),
    ownerId: text('owner_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('deals_client_idx').on(t.clientId),
    index('deals_stage_idx').on(t.stage),
  ]
)

/**
 * `clientId` is denormalized here on purpose: the polymorphic
 * entityType/entityId pair cannot be reached by an RLS policy, so the tenant
 * has to be a real column.
 */
export const activities = pgTable(
  'activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    actorId: text('actor_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    kind: activityKind('kind').notNull().default('note'),
    body: text('body'),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('activities_client_occurred_idx').on(t.clientId, t.occurredAt),
    index('activities_entity_idx').on(t.entityType, t.entityId),
  ]
)

/** Org-wide and staff-only, so deliberately no `clientId`. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: text('actor_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt)]
)

/* -------------------------------------------------------------------------
 * Portal — client-visible
 * ---------------------------------------------------------------------- */

export const links = pgTable(
  'links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    url: text('url').notNull().default(''),
    icon: text('icon'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('links_client_sort_idx').on(t.clientId, t.sortOrder)]
)

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Null when this row is only a link — preserves her paste-a-link habit. */
    storageKey: text('storage_key'),
    mime: text('mime'),
    sizeBytes: integer('size_bytes'),
    externalUrl: text('external_url'),
    uploadedBy: text('uploaded_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('files_client_sort_idx').on(t.clientId, t.sortOrder),
    // A file row is meaningless unless it points at something.
    check(
      'files_has_target',
      sql`${t.storageKey} is not null or ${t.externalUrl} is not null`
    ),
  ]
)

export const noticePosts = pgTable(
  'notice_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => noticePosts.id, {
      onDelete: 'cascade',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('notice_posts_client_created_idx').on(t.clientId, t.createdAt)]
)

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    done: boolean('done').notNull().default(false),
    dueDate: date('due_date'),
    assigneeId: text('assignee_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    /**
     * Lets her run internal work in the same system. Enforced in the RLS
     * policy, not just the query — a client must not see it even if a route
     * forgets to filter.
     */
    visibleToClient: boolean('visible_to_client').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('tasks_client_sort_idx').on(t.clientId, t.sortOrder)]
)

/**
 * The Ideas Bank and the Content Calendar are the same table.
 *
 * Unscheduled rows are ideas; set `scheduledAt` and the row appears on the
 * calendar; its first asset fills a cell in the 3x3 feed preview. In the
 * prototype these were two stores that never spoke, so approving an idea did
 * nothing to the calendar.
 */
export const contentItems = pgTable(
  'content_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    type: contentType('type').notNull().default('graphic'),
    status: contentStatus('status').notNull().default('idea'),
    scheduledAt: date('scheduled_at'),
    /**
     * Time of day, in the client's local reckoning, as a bare `time`.
     *
     * Posting time is a large part of what an agency is paid for — 9am on a
     * Tuesday and 9pm on a Tuesday are different decisions — and a plain date
     * could not express it, so two posts on the same day had no order at all
     * beyond a manual feed position.
     *
     * Deliberately NOT a timestamptz. "Post at 18:30" means half six where the
     * audience is; it is a wall-clock intent, not an instant, and storing it as
     * an instant would silently shift it twice a year at the DST boundary.
     * Nullable, because an undated idea has no time either and a dated post
     * may genuinely not have been given one yet.
     */
    scheduledTime: time('scheduled_time'),
    caption: text('caption'),
    feedOrder: integer('feed_order'),
    /**
     * Her Ideas Bank is a raw backlog, rejected pitches included. Default
     * false; reaching `ready_for_review` sets it true, and it is STICKY —
     * a later status reset must not revoke a client's access to the thread
     * they are mid-conversation in.
     */
    visibleToClient: boolean('visible_to_client').notNull().default(false),
    createdBy: text('created_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Ideas outnumber scheduled posts and the calendar never reads the rest.
    index('content_items_client_scheduled_idx')
      .on(t.clientId, t.scheduledAt)
      .where(sql`${t.scheduledAt} is not null`),
    index('content_items_client_status_idx').on(t.clientId, t.status),
    index('content_items_client_feed_idx')
      .on(t.clientId, t.feedOrder)
      .where(sql`${t.feedOrder} is not null`),
  ]
)

export const reviewLinks = pgTable(
  'review_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    contentItemId: uuid('content_item_id')
      .notNull()
      .references(() => contentItems.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: text('created_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    useCount: integer('use_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('review_links_content_idx').on(t.contentItemId)]
)

export const contentAssets = pgTable(
  'content_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    contentItemId: uuid('content_item_id')
      .notNull()
      .references(() => contentItems.id, { onDelete: 'cascade' }),
    /** Always 1 in the MVP. v1.2 turns versioning on; the column is free now
     *  and awkward to backfill against live client data later. */
    version: integer('version').notNull().default(1),
    kind: assetKind('kind').notNull().default('image'),
    storageKey: text('storage_key').notNull(),
    thumbKey: text('thumb_key'),
    posterKey: text('poster_key'),
    durationMs: integer('duration_ms'),
    width: integer('width'),
    height: integer('height'),
    mime: text('mime'),
    sizeBytes: integer('size_bytes'),
    sortOrder: integer('sort_order').notNull().default(0),
    uploadedBy: text('uploaded_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('content_assets_item_idx').on(t.contentItemId, t.sortOrder),
    index('content_assets_client_idx').on(t.clientId),
  ]
)

/** Append-only. Never updated, never deleted — an approval is a record of
 *  what happened, not a mutable status field. */
export const contentApprovals = pgTable(
  'content_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    contentItemId: uuid('content_item_id')
      .notNull()
      .references(() => contentItems.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    decision: approvalDecision('decision').notNull(),
    actorId: text('actor_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    reviewLinkId: uuid('review_link_id').references(() => reviewLinks.id, {
      onDelete: 'set null',
    }),
    note: text('note'),
    decidedAt: timestamp('decided_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('content_approvals_item_idx').on(t.contentItemId),
    // Exactly one author: a signed-in user or a magic link, never both or
    // neither. The UI has to attribute the decision correctly.
    check(
      'content_approvals_one_actor',
      sql`num_nonnulls(${t.actorId}, ${t.reviewLinkId}) = 1`
    ),
  ]
)

export const contentComments = pgTable(
  'content_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    contentItemId: uuid('content_item_id')
      .notNull()
      .references(() => contentItems.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    authorId: text('author_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    reviewLinkId: uuid('review_link_id').references(() => reviewLinks.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('content_comments_item_idx').on(t.contentItemId, t.createdAt),
    check(
      'content_comments_one_author',
      sql`num_nonnulls(${t.authorId}, ${t.reviewLinkId}) = 1`
    ),
  ]
)

export const moodboardItems = pgTable(
  'moodboard_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key'),
    url: text('url'),
    caption: text('caption'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('moodboard_client_sort_idx').on(t.clientId, t.sortOrder),
    check(
      'moodboard_has_source',
      sql`${t.storageKey} is not null or ${t.url} is not null`
    ),
  ]
)

/* -------------------------------------------------------------------------
 * Infrastructure
 * ---------------------------------------------------------------------- */

/**
 * Client workspace grants staged between invitation and acceptance.
 *
 * The user row does not exist until the invitation is redeemed, so the grant
 * cannot be written at invitation time. Holding it here rather than in process
 * memory means a restart — or a second process, once the worker lands — does
 * not silently drop it.
 *
 * No RLS: like `invitation` itself, this is pre-authentication metadata, read
 * only by a SECURITY DEFINER function during acceptance.
 */
export const invitationGrants = pgTable(
  'invitation_grants',
  {
    invitationId: text('invitation_id')
      .notNull()
      .references(() => invitation.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('invitation_grants_pk').on(t.invitationId, t.clientId),
  ]
)

export const systemMeta = pgTable('system_meta', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/* -------------------------------------------------------------------------
 * Relations
 * ---------------------------------------------------------------------- */

export const clientsRelations = relations(clients, ({ many }) => ({
  access: many(clientAccess),
  contacts: many(contacts),
  deals: many(deals),
  links: many(links),
  files: many(files),
  tasks: many(tasks),
  noticePosts: many(noticePosts),
  contentItems: many(contentItems),
  moodboardItems: many(moodboardItems),
}))

export const clientAccessRelations = relations(clientAccess, ({ one }) => ({
  client: one(clients, {
    fields: [clientAccess.clientId],
    references: [clients.id],
  }),
  user: one(user, { fields: [clientAccess.userId], references: [user.id] }),
}))

export const contentItemsRelations = relations(
  contentItems,
  ({ one, many }) => ({
    client: one(clients, {
      fields: [contentItems.clientId],
      references: [clients.id],
    }),
    assets: many(contentAssets),
    comments: many(contentComments),
    approvals: many(contentApprovals),
  })
)

export const contentAssetsRelations = relations(contentAssets, ({ one }) => ({
  item: one(contentItems, {
    fields: [contentAssets.contentItemId],
    references: [contentItems.id],
  }),
}))

export const contentCommentsRelations = relations(
  contentComments,
  ({ one }) => ({
    item: one(contentItems, {
      fields: [contentComments.contentItemId],
      references: [contentItems.id],
    }),
  })
)

export const contentApprovalsRelations = relations(
  contentApprovals,
  ({ one }) => ({
    item: one(contentItems, {
      fields: [contentApprovals.contentItemId],
      references: [contentItems.id],
    }),
  })
)
