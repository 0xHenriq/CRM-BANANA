import { eq } from 'drizzle-orm'
import type { Tx } from '../db/index.js'
import { files, links, tasks } from '../db/schema.js'

/**
 * Her standard client workspace, seeded when a client's portal opens.
 *
 * Every value here is lifted verbatim from her prototype's default state. The
 * link and file names are not placeholders — they are her actual onboarding
 * process written down, in her order: proposal, kick-off, agreement, strategy,
 * shoot planning, shot list, content, reports, invoices.
 *
 * Static in the MVP. v1.1 promotes this into editable `templates` so the
 * process lives in the product rather than in this file, but the shape and the
 * demo are identical either way — and this costs a day less.
 */

/**
 * `url` is filled in per client, except where the destination is a page of
 * this application and is therefore the same every time.
 *
 * Social Profiles was one link covering three networks, so the one thing a
 * social client checks most often needed a click and a guess. It is now the
 * three she actually runs — TikTok, Instagram, Facebook — each with its own
 * slot to paste into.
 */
const DEFAULT_LINKS = [
  { label: 'TikTok', icon: 'music-2', url: '' },
  { label: 'Instagram', icon: 'instagram', url: '' },
  { label: 'Facebook', icon: 'facebook', url: '' },
  { label: 'Google Drive', icon: 'folder', url: '' },
  { label: 'Meeting Notes', icon: 'notebook-pen', url: '' },
  { label: 'Proposal', icon: 'file-text', url: '' },
  { label: 'Canva Project', icon: 'palette', url: '' },
  /**
   * Points at this application's own calendar rather than waiting for a URL to
   * be pasted. It is the one link in the stack whose destination we already
   * know, and leaving it blank meant the most-used page in the product was
   * reachable only from the sidebar — which a client on a phone does not see.
   */
  { label: 'Content Calendar', icon: 'calendar-days', url: '/portal/calendar' },
  { label: 'Kick Off Meeting', icon: 'star', url: '' },
  { label: 'Shot List', icon: 'camera', url: '' },
] as const

/**
 * The named slots the File Folder opens with. These ARE the categories.
 *
 * Exported so migration 0017's backfill and this list cannot disagree about
 * what a new workspace gets: seeding only runs when a portal is first opened,
 * so anything added here never reaches a client who already has a workspace
 * unless a migration puts it there too.
 */
export const DEFAULT_FILES = [
  'Agreement',
  'Invoices',
  'Reports',
  'Social Strategy',
  'Shoot Planning',
  // She asked for this one by name.
  'Brief',
] as const

/**
 * Her four onboarding steps. The first two shipped ticked in the prototype;
 * here they all start open, because a freshly created client has genuinely not
 * been onboarded yet.
 *
 * Visible to the client: these are the steps she walks them through, and the
 * point of the portal is that they can see where they are in it. Internal work
 * gets `visible_to_client: false` on a per-task basis instead.
 */
const DEFAULT_TASKS = ['Onboarding', 'Strategy', 'Socials', 'Content'] as const

export async function seedNewClientWorkspace(
  tx: Tx,
  clientId: string
): Promise<void> {
  // Idempotent by construction: portal-opening is guarded on the transition,
  // but a retried request or a re-run migration must not double the stack.
  const existing = await tx
    .select({ id: links.id })
    .from(links)
    .where(eq(links.clientId, clientId))
    .limit(1)
  if (existing.length > 0) return

  await tx.insert(links).values(
    DEFAULT_LINKS.map((l, i) => ({
      clientId,
      label: l.label,
      icon: l.icon,
      url: l.url,
      sortOrder: i,
    }))
  )

  // externalUrl '' rather than null: the CHECK requires a target, and an empty
  // string is the honest representation of "a slot she has not filled yet".
  await tx.insert(files).values(
    DEFAULT_FILES.map((name, i) => ({
      clientId,
      name,
      externalUrl: '',
      sortOrder: i,
    }))
  )

  await tx.insert(tasks).values(
    DEFAULT_TASKS.map((title, i) => ({
      clientId,
      title,
      visibleToClient: true,
      sortOrder: i,
    }))
  )
}
