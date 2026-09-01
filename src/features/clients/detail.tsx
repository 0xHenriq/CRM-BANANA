import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Loader2,
  Mail,
  Phone,
  Plus,
  Star,
  Trash2,
  MessageSquare,
  ArrowRightLeft,
  Share2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  ApiError,
  BRAND_COLOR_ROLES,
  BRAND_COLOR_SLOTS,
  brandPalette,
  formatMoney,
  formatShortDate,
  type InviteResult,
  linkState,
  localDayOf,
  normaliseHex,
  type ShareLink,
  type ClientDetail,
  CLIENT_STATUSES,
  type PortalWorkspace,
} from '@/lib/api'
import { copyText } from '@/lib/copy-text'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ClientLogo } from '@/components/client-logo'
import { ConfigDrawer } from '@/components/config-drawer'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PageHead } from '@/components/layout/page-head'
import { QueryError } from '@/components/layout/query-error'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { ThemeSwitch } from '@/components/theme-switch'
import { CalendarPreview } from '@/features/content/calendar-preview'
import { IdeasPreview } from '@/features/content/ideas-preview'
import { MoodboardPreview } from '@/features/content/moodboard-preview'
import { NextSteps } from '@/features/content/review-queue'
import { InvoicesPanel } from '@/features/invoices/panel'
import { LinkStack } from '@/features/portal/link-stack'
import { FileFolder, TaskList } from '@/features/portal/panels'
import { useWorkspace } from '@/features/portal/use-workspace'
import { CLIENT_TAB_LABEL, CLIENT_TAB_VALUES, type ClientTab } from './tabs'
import {
  ClientStatusPill,
  DealStagePill,
  PaymentBadge,
  CLIENT_LABEL,
} from './status-pill'

export function ClientDetailPage({
  tab,
  onTabChange,
}: {
  tab: ClientTab
  onTabChange: (next: ClientTab) => void
}) {
  const { clientId } = useParams({ from: '/_authenticated/clients_/$clientId' })
  const queryClient = useQueryClient()
  const { setClientId } = useWorkspace()

  /**
   * Opening a client's page makes that client the active workspace.
   *
   * Without this the panels here show client X while every link out of them —
   * "Open board", the Content Calendar row in the link stack — lands on
   * whichever workspace was last persisted, which may be a different client
   * entirely. That is precisely the defect use-workspace.ts was written to end:
   * a selection living in one place and guessed in another, so you approve or
   * schedule against the wrong client without anything on screen saying so.
   *
   * On the PAGE and not in ClientWorkspace, which is where it used to live:
   * that component now mounts only on the Work and Files tabs, so opening a
   * client and staying on Overview would have left the previous client active
   * — and the Ideas and Calendar previews on the Work tab read the workspace
   * client too. The rule is "opening a client's page", so it belongs to the
   * page.
   */
  useEffect(() => {
    setClientId(clientId)
  }, [clientId, setClientId])

  // Radix hands back a plain string; the route's schema is what guarantees the
  // value is one of ours, so the cast is narrowing to what has already been
  // validated rather than an assumption.
  const setTab = (next: string) => onTabChange(next as ClientTab)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['client', clientId],
    queryFn: () => api.get<ClientDetail>(`/clients/${clientId}`),
  })

  const [confirmArchive, setConfirmArchive] = useState(false)

  const archive = useMutation({
    mutationFn: () => api.post(`/clients/${clientId}/archive`, {}),
    onSuccess: async () => {
      setConfirmArchive(false)
      toast.success('Client archived. Nothing was deleted.')
      await queryClient.invalidateQueries({ queryKey: ['client', clientId] })
      await queryClient.invalidateQueries({ queryKey: ['clients'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const restore = useMutation({
    mutationFn: () => api.post(`/clients/${clientId}/restore`, {}),
    onSuccess: async () => {
      toast.success('Client restored.')
      await queryClient.invalidateQueries({ queryKey: ['client', clientId] })
      await queryClient.invalidateQueries({ queryKey: ['clients'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch(`/clients/${clientId}`, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['client', clientId] })
      await queryClient.invalidateQueries({ queryKey: ['clients'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // A failed query previously left `data` undefined and `isLoading` false,
  // so this component rendered skeletons forever — verified against a
  // non-existent client id. An error needs its own branch and a way out.
  if (isError || (!isLoading && !data)) {
    return (
      <>
        <Header>
          <div className='ms-auto flex items-center gap-2'>
            <ThemeSwitch />
            <ProfileDropdown />
          </div>
        </Header>
        <Main>
          {/* Only claim "not found" when the server actually said 404 — a
              network failure or a 500 is a different problem, and telling her
              the client does not exist would send her looking for the wrong
              thing. */}
          <PageHead
            eyebrow='Client account'
            title={
              error instanceof ApiError && error.status === 404
                ? 'Not found'
                : 'Unavailable'
            }
          />
          <QueryError
            title={
              error instanceof ApiError && error.status === 404
                ? 'That client does not exist, or you no longer have access.'
                : 'Could not load this client'
            }
            error={error as Error}
            onRetry={() => refetch()}
          />
          <div className='mt-4'>
            <Button variant='outline' asChild>
              <Link to='/clients'>
                <ArrowLeft />
                Back to clients
              </Link>
            </Button>
          </div>
        </Main>
      </>
    )
  }

  if (isLoading || !data) {
    return (
      <>
        <Header>
          <div className='ms-auto flex items-center gap-2'>
            <ThemeSwitch />
            <ProfileDropdown />
          </div>
        </Header>
        <Main>
          <Skeleton className='mb-6 h-20' />
          <Skeleton className='h-64' />
        </Main>
      </>
    )
  }

  // `pendingInvites` defaults because it is a NEW field on this payload: for a
  // few seconds after a deploy, an open tab can render a response cached from
  // before it, and `undefined.map` blanks the whole client page rather than
  // degrading. An absent list genuinely is an empty list, so this is a default
  // and not a guess.
  const { client, contacts, deals, timeline, seats, pendingInvites = [] } = data

  return (
    <>
      <Header>
        <div className='ms-auto flex items-center gap-2'>
          <ThemeSwitch />
          <ConfigDrawer />
          <ProfileDropdown />
        </div>
      </Header>

      <Main>
        {/*
          Their mark where the agency's stamp used to be.

          The "EST. BD LDN" circle is ours, and on a page that is entirely
          about one client it was the least useful thing in the header. The
          mark takes that position — round, so it reads as the same object —
          and because ClientLogo is an upload target when `canEdit`, the
          circle is also how she sets their logo. One mark, not two: there
          used to be a second `markOnly` copy at the start of this row.
        */}
        <PageHead
          eyebrow='Client account'
          title={client.name}
          actions={
            <div className='flex items-center gap-3'>
              <Button variant='outline' size='sm' asChild>
                <Link to='/clients'>
                  <ArrowLeft />
                  Clients
                </Link>
              </Button>
              <ClientStatusPill status={client.status} />
              <ShareClientMenu clientId={clientId} />
              <ClientLogo
                clientId={clientId}
                name={client.name}
                logoKey={client.logoKey}
                brandColor={client.brandColor}
                canEdit
                markOnly
                round
              />
            </div>
          }
        />

        {/*
          This client's next actions, before anything else on the page.

          Sofia asked for "waiting on clients" to be individual to each client:
          the dashboard list answers "what is outstanding everywhere", which is
          the wrong question once she has opened one client's page. Same
          component and same endpoint as the dashboard, narrowed by id, so the
          two cannot disagree about what counts as a step.
        */}
        <NextSteps variant='agency' clientId={clientId} />

        {/*
          Four tabs, because thirteen blocks in one column is not a page.

          NextSteps stays ABOVE them on purpose: it is the "what do I do now"
          panel and hiding it behind a tab would mean she has to remember to go
          and look, which is exactly the thing it exists to stop.

          Each panel keeps its own query. Lifting them into one loader would
          couple four independent screens together and lose the invalidation
          that already works — the workspace panels invalidate ['portal', id]
          and the CRM cards ['client', id], and an edit in one refreshes the
          other today.
        */}
        <Tabs value={tab} onValueChange={setTab} className='gap-5'>
          <TabsList>
            {CLIENT_TAB_VALUES.map((value) => (
              <TabsTrigger key={value} value={value} className='px-4'>
                {CLIENT_TAB_LABEL[value]}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value='overview'>
            <div className='grid gap-5 lg:grid-cols-3'>
              <div className='space-y-5 lg:col-span-2'>
                <BrandCard client={client} patch={patch} />
                <AccountCard
                  client={client}
                  seats={seats}
                  patch={patch}
                  restore={restore}
                  onArchive={() => setConfirmArchive(true)}
                />
                <ContactsCard
                  clientId={clientId}
                  contacts={contacts}
                  seats={seats}
                  pendingInvites={pendingInvites}
                />
              </div>

              <TimelineCard clientId={clientId} timeline={timeline} />
            </div>
          </TabsContent>

          <TabsContent value='work'>
            <div className='space-y-5'>
              {/*
                Ideas and the calendar are NOT behind the portal gate below.
                Content items belong to the client, not to their workspace, so
                she can plan and schedule for someone still at proposal stage —
                which is when a moodboard and a calendar are most of the pitch.
              */}
              <div className='grid items-start gap-5 lg:grid-cols-2'>
                <IdeasPreview clientId={clientId} />
                <CalendarPreview clientId={clientId} />
              </div>

              <MoodboardPreview clientId={clientId} canEdit />

              {client.portalEnabled ? (
                <ClientWorkspace clientId={clientId} section='work' />
              ) : (
                <NoWorkspace name={client.name} />
              )}
            </div>
          </TabsContent>

          <TabsContent value='money'>
            <div className='space-y-5'>
              {/* What this client owes, on the page about this client. */}
              <InvoicesPanel clientId={clientId} canEdit />
              <Card className='crate-card'>
                <CardHeader>
                  <CardTitle className='pb-2 display text-lg crate-rule'>
                    Deals
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {deals.length === 0 ? (
                    <p className='text-sm text-muted-foreground'>
                      No deals yet. Add one from the Pipeline board.
                    </p>
                  ) : (
                    <ul className='divide-y divide-bd-rule-soft'>
                      {deals.map((d) => (
                        <li
                          key={d.id}
                          className='flex items-center justify-between gap-3 py-2.5'
                        >
                          <div className='min-w-0'>
                            <p className='truncate text-sm font-semibold'>
                              {d.title}
                            </p>
                            {d.expectedClose && (
                              <p className='text-xs text-muted-foreground'>
                                Expected {d.expectedClose}
                              </p>
                            )}
                          </div>
                          <div className='flex shrink-0 items-center gap-3'>
                            <span className='display text-base'>
                              {formatMoney(d.value, d.currency)}
                            </span>
                            {/* The same badge the pipeline shows. "Which of
                                these has he actually paid" is asked here more
                                often than on the board. */}
                            <PaymentBadge deal={d} />
                            <DealStagePill stage={d.stage} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value='files'>
            {client.portalEnabled ? (
              <ClientWorkspace clientId={clientId} section='files' />
            ) : (
              <NoWorkspace name={client.name} />
            )}
          </TabsContent>
        </Tabs>


        {/*
        Named confirmation, and the wording says what it does NOT do.

        "Are you sure?" over a destructive-looking button teaches people to
        click through. This one states plainly that nothing is deleted, which
        is both true and the thing she would otherwise have to find out by
        risking a real client's data to see what happens.
      */}
        <ConfirmDialog
          open={confirmArchive}
          onOpenChange={setConfirmArchive}
          title={`Archive ${client.name}?`}
          desc={
            <>
              They come off your client list, the pipeline and your next steps,
              and their portal closes. Nothing is deleted — their content, files
              and uploads stay exactly where they are, and you can restore them
              at any time.
              <br />
              <br />
              {/* Stated because it is a deliberate exception, and a surprising
                  one: tidying a client away must not make money owed vanish. */}
              <strong>Unpaid invoices stay visible</strong> so you do not lose
              sight of what they still owe.
            </>
          }
          confirmText='Archive'
          isLoading={archive.isPending}
          handleConfirm={() => archive.mutate()}
        />
      </Main>
    </>
  )
}

/**
 * R06: the top-right control, once share links exist.
 *
 * Two doors, both of which now go somewhere: give somebody a login (the seat
 * invite from phase 3), or send a read-only feed preview.
 *
 * What she asked for was "almost like a web page they can just view all of it
 * on" — a read-only version of THIS page — and that is deliberately not built.
 * This page carries invoices, deal values and her private activity timeline.
 * A feed preview is the part a client should see, and it is the part that was
 * actually being asked about.
 */
function ShareClientMenu({ clientId }: { clientId: string }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [fresh, setFresh] = useState<string | null>(null)
  const now = new Date()

  // Only while the menu is open. Nothing outside it reads this, and without
  // the gate every client page load fetched share links nobody had asked to
  // see.
  const { data } = useQuery({
    queryKey: ['feed-shares', clientId],
    queryFn: () =>
      api.get<{ links: ShareLink[] }>(`/shares/client/${clientId}/feed`),
    enabled: open,
  })

  const mint = useMutation({
    mutationFn: () =>
      api.post<{ url: string }>(`/shares/client/${clientId}/feed`, {}),
    onSuccess: async (result) => {
      setFresh(result.url)
      const ok = await copyText(result.url)
      toast[ok ? 'success' : 'error'](
        ok
          ? 'Feed preview link copied. It cannot be shown again.'
          : 'Link created — copy it from the box, it cannot be shown again.'
      )
      await queryClient.invalidateQueries({ queryKey: ['feed-shares', clientId] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/shares/${id}/revoke`, {}),
    onSuccess: async () => {
      toast.success('Link revoked.')
      await queryClient.invalidateQueries({ queryKey: ['feed-shares', clientId] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const live = (data?.links ?? []).filter((l) => linkState(l, now) === 'live')

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setFresh(null)
      }}
    >
      <PopoverTrigger asChild>
        <Button size='sm' variant='outline'>
          <Share2 />
          Share
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-80 crate-card'>
        <div className='space-y-3'>
          <div>
            <p className='display text-sm'>Share the feed preview</p>
            <p className='text-xs text-muted-foreground'>
              A read-only grid of what is coming up. No sign-in, and anyone
              with the link can open it.
            </p>
            {/*
              Said out loud, because the grid she is looking at and the grid
              they get are not the same one. Feed Preview shows her everything
              including internal concepts; a share link shows only what is
              already shared with the client. Without this she sends nine cells
              and they open seven, and the first she hears of it is them asking.
            */}
            <p className='mt-1 text-xs text-muted-foreground'>
              Only posts already shared with the client appear — internal ones
              are left out.
            </p>
          </div>

          {fresh && (
            <>
              <Input readOnly value={fresh} className='font-mono text-xs' />
              <p className='text-xs text-muted-foreground'>
                Copy it now — it cannot be displayed again.
              </p>
            </>
          )}

          <Button
            size='sm'
            className='w-full'
            onClick={() => mint.mutate()}
            disabled={mint.isPending}
          >
            {mint.isPending && <Loader2 className='animate-spin' />}
            {live.length ? 'Create another link' : 'Create a link'}
          </Button>

          {live.length > 0 && (
            <ul className='space-y-1.5 text-xs'>
              {live.map((l) => (
                <li key={l.id} className='flex items-center gap-2'>
                  <span className='min-w-0 flex-1 truncate'>
                    {l.useCount === 0
                      ? 'Not opened yet'
                      : `Opened ${l.useCount} time${l.useCount === 1 ? '' : 's'}`}
                    , expires {formatShortDate(localDayOf(l.expiresAt))}
                  </span>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-6 shrink-0 px-2 text-xs'
                    onClick={() => revoke.mutate(l.id)}
                    disabled={revoke.isPending}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className='crate-rule' />
          <p className='text-xs text-muted-foreground'>
            Need them to see invoices and files too? Give them a login from a
            contact below, or on the Seats page.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Anything that mutates the client row goes through the page's one PATCH.
 *
 * Typed structurally rather than as a UseMutationResult so these cards state
 * exactly what they need — a way to send a partial client — and cannot quietly
 * start reaching for status, reset() or the mutation's cached data.
 */
type PatchMutation = { mutate: (body: Record<string, unknown>) => void }

function AccountCard({
  client,
  seats,
  patch,
  restore,
  onArchive,
}: {
  client: ClientDetail['client']
  seats: ClientDetail['seats']
  patch: PatchMutation
  restore: { mutate: () => void; isPending: boolean }
  onArchive: () => void
}) {
  return (
    <Card className='crate-card'>
      <CardHeader>
        <CardTitle className='pb-2 display text-lg crate-rule'>
          Account
        </CardTitle>
      </CardHeader>
      <CardContent className='grid gap-4 sm:grid-cols-2'>
        {/*
          Renaming was the gap. Status and the portal toggle were
          editable, but a client typed in with a typo could only be
          fixed by creating a second one — which is how two of these
          ended up on her list in the first place.

          On blur rather than on every keystroke: a PATCH per character
          would put a hundred rows through the activity log for one
          rename.
        */}
        <div className='grid gap-1.5'>
          <Label htmlFor='client-rename'>Name</Label>
          <Input
            id='client-rename'
            defaultValue={client.name}
            key={`name-${client.id}-${client.updatedAt}`}
            onBlur={(e) => {
              const next = e.target.value.trim()
              if (next && next !== client.name) {
                patch.mutate({ name: next })
              }
            }}
          />
        </div>

        <div className='grid gap-1.5'>
          <Label>Status</Label>
          <Select
            value={client.status}
            onValueChange={(v) => patch.mutate({ status: v })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLIENT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {CLIENT_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className='grid gap-1.5'>
          <Label htmlFor='portal-toggle'>Client portal</Label>
          <div className='flex h-9 items-center gap-2.5'>
            <Switch
              id='portal-toggle'
              checked={client.portalEnabled}
              onCheckedChange={(v) =>
                patch.mutate({ portalEnabled: v })
              }
            />
            <span className='text-sm text-muted-foreground'>
              {client.portalEnabled
                ? `${seats.length} seat${seats.length === 1 ? '' : 's'} with access`
                : 'Closed'}
            </span>
          </div>
        </div>

        {/*
          Archive, not delete.

          She asked to be able to remove a client, and two on her list
          are not hers. This takes them off every screen and closes
          their portal, and Restore puts them back — because a client
          is the parent of their content, files, invoices, receipts and
          every uploaded byte, and a real delete would take all of it
          with no way back that does not involve a backup.
        */}
        <div className='flex flex-wrap items-center justify-between gap-2 pt-4 crate-rule sm:col-span-2'>
          {client.archivedAt ? (
            <>
              <p className='text-xs text-muted-foreground'>
                Archived. Hidden from your client list, and their portal
                is closed. Nothing has been deleted.
              </p>
              <Button
                size='sm'
                variant='outline'
                onClick={() => restore.mutate()}
                disabled={restore.isPending}
              >
                {restore.isPending ? (
                  <Loader2 className='animate-spin' />
                ) : (
                  <ArchiveRestore />
                )}
                Restore
              </Button>
            </>
          ) : (
            <>
              <p className='text-xs text-muted-foreground'>
                Archiving takes this client off your list, pipeline and
                next steps, and closes their portal. It deletes nothing
                and can be undone.
              </p>
              <Button
                size='sm'
                variant='outline'
                onClick={() => onArchive()}
              >
                <Archive />
                Archive client
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * The brief, the tone of voice, and the five brand colours.
 *
 * All three are things she was keeping somewhere else: the brief was going
 * into the Activity log, which is append-only and scrolls away, so a live
 * campaign's brief ended up under three months of "called, no answer"; the
 * tone of voice was in her head; and there was one brand colour where a brand
 * has five.
 *
 * First card on the page because it is what the page is about. Everything
 * below it — status, portal, invoices — is administration.
 */
function BrandCard({
  client,
  patch,
}: {
  client: ClientDetail['client']
  patch: PatchMutation
}) {
  const palette = brandPalette(client.brandColors)

  /**
   * Which swatch she has actually touched, per slot.
   *
   * A ref rather than state because nothing on screen depends on it, and the
   * gate itself is the thing that matters: `<input type="color">` reports a
   * value even when it has never been opened, so saving on "the value differs
   * from what is stored" assigns a colour to every slot she tabs past. That is
   * not hypothetical — it is the bug the single colour input had, where every
   * client's null brand colour "differed" from the yellow the picker showed,
   * and a tab through this card wrote a colour nobody chose plus an activity
   * row claiming she chose it.
   *
   * onChange records the touch (it fires continuously while a colour is
   * dragged, so it must not be the thing that saves); blur saves.
   */
  const touched = useRef<boolean[]>(
    Array.from({ length: BRAND_COLOR_SLOTS }, () => false)
  )

  /** Writes the whole palette, because the PATCH takes the whole palette. */
  const commit = (slot: number, value: string) => {
    if (palette[slot] === value) return
    const next = [...palette]
    next[slot] = value
    patch.mutate({ brandColors: next })
  }

  return (
    <Card className='crate-card'>
      <CardHeader>
        <CardTitle className='pb-2 display text-lg crate-rule'>
          Brand
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-5'>
        <div className='grid gap-1.5'>
          <Label htmlFor='client-brief'>Project brief</Label>
          <Textarea
            id='client-brief'
            /*
             * Keyed on the client, NOT on updatedAt like the name field above.
             *
             * updatedAt changes on every save anywhere on this page, which
             * remounts the field — harmless for a one-line name, and a way to
             * lose half a paragraph here if an unrelated panel saves while she
             * is typing. Nothing but this field writes this field, so there is
             * no server-side change to pick up.
             */
            key={`brief-${client.id}`}
            defaultValue={client.brief ?? ''}
            placeholder='What are we making for them, and why? Campaign, goals, audience, must-haves.'
            className='min-h-28 resize-y'
            onBlur={(e) => {
              const next = e.target.value.trim()
              if (next !== (client.brief ?? '')) patch.mutate({ brief: next })
            }}
          />
          <p className='text-xs text-muted-foreground'>
            Shown in their portal, so they can see what the work is for.
          </p>
        </div>

        <div className='grid gap-1.5'>
          <Label htmlFor='client-tone'>Tone of voice</Label>
          <Textarea
            id='client-tone'
            key={`tone-${client.id}`}
            defaultValue={client.toneOfVoice ?? ''}
            placeholder='How they want to sound. Warm and plain? Playful? Never emoji?'
            className='min-h-20 resize-y'
            onBlur={(e) => {
              const next = e.target.value.trim()
              if (next !== (client.toneOfVoice ?? '')) {
                patch.mutate({ toneOfVoice: next })
              }
            }}
          />
          <p className='text-xs text-muted-foreground'>
            Shown in their portal, so they can check you got it right.
          </p>
        </div>

        <div className='grid gap-2'>
          <Label>Brand colours</Label>
          <div className='flex flex-wrap gap-4'>
            {BRAND_COLOR_ROLES.map((role, slot) => {
              const value = palette[slot]
              return (
                <div key={role} className='grid w-28 gap-1.5'>
                  <div className='flex items-center gap-2'>
                    <input
                      type='color'
                      aria-label={role}
                      className={cn(
                        'size-9 shrink-0 cursor-pointer rounded-md bg-transparent p-1',
                        value
                          ? 'border border-border'
                          : 'border border-dashed border-muted-foreground/60 opacity-60'
                      )}
                      /* A slot she has not set opens on the house yellow —
                         somewhere to start rather than a black square. */
                      defaultValue={value || '#f5c518'}
                      key={`swatch-${client.id}-${slot}-${client.updatedAt}`}
                      onChange={() => {
                        touched.current[slot] = true
                      }}
                      onBlur={(e) => {
                        if (!touched.current[slot]) return
                        touched.current[slot] = false
                        commit(slot, e.target.value.toLowerCase())
                      }}
                    />
                    {value && (
                      <Button
                        type='button'
                        size='icon'
                        variant='ghost'
                        className='size-7'
                        aria-label={`Clear ${role}`}
                        onClick={() => commit(slot, '')}
                      >
                        <X className='size-3.5' />
                      </Button>
                    )}
                  </div>
                  {/*
                    A text field beside the picker because a palette arrives as
                    a list of hex codes from a brand guide, and a colour picker
                    cannot be pasted into. normaliseHex takes it with or
                    without the hash, three digits or six, any case.
                  */}
                  <Input
                    aria-label={`${role} hex`}
                    className='h-7 px-2 font-mono text-xs'
                    placeholder='Not set'
                    key={`hex-${client.id}-${slot}-${client.updatedAt}`}
                    defaultValue={value}
                    onBlur={(e) => {
                      const raw = e.target.value.trim()
                      if (raw === '') {
                        commit(slot, '')
                        return
                      }
                      const hex = normaliseHex(raw)
                      if (!hex) {
                        // Say what was wrong and put the field back, rather
                        // than sending it and letting the server answer.
                        toast.error(
                          `"${raw}" is not a colour. Try a hex code like #1a2b3c.`
                        )
                        e.target.value = value
                        return
                      }
                      commit(slot, hex)
                    }}
                  />
                  <span className='text-[0.6875rem] text-muted-foreground'>
                    {role}
                  </span>
                </div>
              )
            })}
          </div>
          <p className='text-xs text-muted-foreground'>
            Primary 1 is what their initials sit on when they have no logo.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Shown on the Work and Files tabs when the portal has never been opened.
 *
 * Saying why rather than showing nothing: a client at proposal or paused has
 * no seeded workspace at all, so the panels would be four empty boxes — and
 * silently omitting them reads as a missing feature rather than a switch that
 * has not been thrown.
 */
function NoWorkspace({ name }: { name: string }) {
  return (
    <Card className='crate-card border-dashed'>
      <CardContent className='py-4 text-sm text-muted-foreground'>
        <strong>{name}</strong> has no workspace yet. Turn on{' '}
        <strong>Client portal</strong> on the Overview tab to create their link
        stack, file folder and onboarding to-do&rsquo;s.
      </CardContent>
    </Card>
  )
}

/**
 * Who she talks to, and whether they can actually get in.
 *
 * Sofia asked for a green tag on contacts who have portal access and a way to
 * invite the ones who do not. The tag is a join she nearly had: this page
 * already loads `seats` — the users with access to THIS workspace — so a
 * contact is "Active" when their email matches one.
 *
 * Three states, not two. "Invited" is the one that is easy to miss and
 * expensive to get wrong: an invitation holds one of ten seats from the moment
 * it is sent, so a contact who looks uninvited gets invited twice and holds
 * two.
 */
function ContactsCard({
  clientId,
  contacts,
  seats,
  pendingInvites,
}: {
  clientId: string
  contacts: ClientDetail['contacts']
  seats: ClientDetail['seats']
  pendingInvites: ClientDetail['pendingInvites']
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    title: '',
    isPrimary: false,
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['client', clientId] })

  const add = useMutation({
    mutationFn: () =>
      api.post(`/clients/${clientId}/contacts`, {
        name: form.name.trim(),
        // Empty strings would fail email validation server-side; null is the
        // honest value for "not provided".
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        title: form.title.trim() || null,
        isPrimary: form.isPrimary,
      }),
    onSuccess: async () => {
      await invalidate()
      setOpen(false)
      setForm({ name: '', email: '', phone: '', title: '', isPrimary: false })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const remove = useMutation({
    mutationFn: (contactId: string) =>
      api.del(`/clients/${clientId}/contacts/${contactId}`),
    onSuccess: invalidate,
    // Was missing: a failed delete left the row on screen with no explanation,
    // which reads as the button not working.
    onError: (err: Error) => toast.error(err.message),
  })

  /**
   * Emails are compared case-insensitively and trimmed.
   *
   * She types contacts by hand and invitations are typed by hand too, so
   * "Jane@Acme.com " and "jane@acme.com" are one person to everyone except a
   * strict string compare — which would show an active client as invitable and
   * offer to burn a seat re-inviting them.
   */
  const key = (email: string | null | undefined) =>
    email?.trim().toLowerCase() ?? ''
  const active = new Set(seats.map((s) => key(s.email)))
  const invited = new Set(pendingInvites.map((p) => key(p.email)))

  const invite = useMutation({
    mutationFn: (email: string) =>
      api.post<InviteResult>('/seats/invite', {
        email,
        role: 'client',
        clientIds: [clientId],
      }),
    onSuccess: async (result) => {
      // An address that already has an account is granted access outright —
      // there is no link, because there is nothing for them to accept. They
      // just sign in with what they already have.
      if (result.kind === 'granted') {
        toast.success(
          result.restored
            ? `${result.email} already had an account, so their seat is back and this workspace is open to them.`
            : `${result.email} already has a login — this workspace is now open to them. Nothing to send.`
        )
      } else {
        const ok = await copyText(result.inviteUrl)
        // Says what it did, and does not pretend to have emailed anyone.
        toast[ok ? 'success' : 'error'](
          ok
            ? 'Invite link copied. Send it to them yourself — there is no email delivery yet.'
            : `Invitation created, but the copy failed. The link is ${result.inviteUrl}`,
          { duration: ok ? 6000 : 30000 }
        )
      }
      await invalidate()
      await queryClient.invalidateQueries({ queryKey: ['seats'] })
      // A grant writes client_access, which is the Seats metric on every card
      // in the Clients list.
      await queryClient.invalidateQueries({ queryKey: ['clients'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <Card className='crate-card'>
      <CardHeader className='flex flex-row items-center justify-between'>
        <CardTitle className='display text-lg'>Contacts</CardTitle>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size='sm' variant='outline'>
              <Plus /> Add
            </Button>
          </DialogTrigger>
          <DialogContent className='crate-card sm:max-w-md'>
            <DialogHeader>
              <DialogTitle className='display text-xl'>New contact</DialogTitle>
            </DialogHeader>
            <div className='grid gap-3'>
              {(['name', 'title', 'email', 'phone'] as const).map((field) => (
                <div key={field} className='grid gap-1.5'>
                  <Label htmlFor={`contact-${field}`} className='capitalize'>
                    {field}
                  </Label>
                  <Input
                    id={`contact-${field}`}
                    value={form[field]}
                    onChange={(e) =>
                      setForm({ ...form, [field]: e.target.value })
                    }
                    type={field === 'email' ? 'email' : 'text'}
                  />
                </div>
              ))}
              <label className='flex items-center gap-2 text-sm'>
                <input
                  type='checkbox'
                  checked={form.isPrimary}
                  onChange={(e) =>
                    setForm({ ...form, isPrimary: e.target.checked })
                  }
                  className='size-4 accent-bd-yellow-deep'
                />
                Primary contact
              </label>
            </div>
            <DialogFooter>
              <Button
                onClick={() => add.mutate()}
                disabled={!form.name.trim() || add.isPending}
              >
                Add contact
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {contacts.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            No contacts yet — who do you call?
          </p>
        ) : (
          <ul className='divide-y divide-bd-rule-soft'>
            {contacts.map((contact) => (
              <li
                key={contact.id}
                className='group flex items-center justify-between gap-3 py-2.5'
              >
                <div className='min-w-0'>
                  <p className='flex items-center gap-1.5 text-sm font-semibold'>
                    {contact.isPrimary && (
                      <Star
                        className='size-3.5 fill-bd-yellow text-bd-ink'
                        aria-label='Primary contact'
                      />
                    )}
                    {contact.name}
                    {contact.title && (
                      <span className='font-normal text-muted-foreground'>
                        · {contact.title}
                      </span>
                    )}
                  </p>
                  <p className='flex flex-wrap gap-3 text-xs text-muted-foreground'>
                    {contact.email && (
                      <a
                        href={`mailto:${contact.email}`}
                        className='flex items-center gap-1 hover:underline'
                      >
                        <Mail className='size-3' />
                        {contact.email}
                      </a>
                    )}
                    {contact.phone && (
                      <a
                        href={`tel:${contact.phone}`}
                        className='flex items-center gap-1 hover:underline'
                      >
                        <Phone className='size-3' />
                        {contact.phone}
                      </a>
                    )}
                  </p>
                </div>
                <div className='flex shrink-0 items-center gap-2'>
                  <ContactAccess
                    contact={contact}
                    isActive={active.has(key(contact.email))}
                    isInvited={invited.has(key(contact.email))}
                    onInvite={() => invite.mutate(contact.email!.trim())}
                    isInviting={
                      invite.isPending &&
                      invite.variables === contact.email?.trim()
                    }
                  />
                  <Button
                    size='icon'
                    variant='ghost'
                    className='opacity-0 group-hover:opacity-100'
                    onClick={() => remove.mutate(contact.id)}
                    aria-label={`Remove ${contact.name}`}
                  >
                    <Trash2 className='size-4 text-destructive' />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Portal access for one contact: a state, and the one action that changes it.
 *
 * Deliberately NOT a "See it from their view" button, which is what she asked
 * for alongside this. That is impersonation, and the whole security model is
 * Postgres RLS keyed on `app.user_id` — anything that fakes a client context
 * is touching the single thing keeping tenants apart. A read-only preview that
 * renders the portal under the client's own visibility rules is the safe
 * shape, and it deserves its own review rather than being smuggled in here.
 */
function ContactAccess({
  contact,
  isActive,
  isInvited,
  onInvite,
  isInviting,
}: {
  contact: ClientDetail['contacts'][number]
  isActive: boolean
  isInvited: boolean
  onInvite: () => void
  isInviting: boolean
}) {
  // No email, no invitation — there is nowhere to send it. Say so rather than
  // offering a button that cannot work.
  if (!contact.email?.trim()) {
    return (
      <span className='text-[0.6875rem] text-muted-foreground'>No email</span>
    )
  }

  if (isActive) {
    return (
      <span
        className='rounded-full border-[1.5px] border-bd-ink bg-tag-video px-2 py-0.5 text-[0.6875rem] font-bold whitespace-nowrap text-bd-ink'
        title='They have a login and can see this workspace'
      >
        Active
      </span>
    )
  }

  if (isInvited) {
    return (
      <span
        className='rounded-full border-[1.5px] border-bd-rule bg-bd-sand px-2 py-0.5 text-[0.6875rem] font-bold whitespace-nowrap text-bd-ink'
        title='Invited — the link has been created and is holding a seat until they accept it'
      >
        Invited
      </span>
    )
  }

  return (
    <Button
      size='sm'
      variant='outline'
      className='h-7 px-2 text-xs'
      onClick={onInvite}
      disabled={isInviting}
    >
      {isInviting ? <Loader2 className='animate-spin' /> : <Mail />}
      Copy invite link
    </Button>
  )
}

function TimelineCard({
  clientId,
  timeline,
}: {
  clientId: string
  timeline: ClientDetail['timeline']
}) {
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')

  const addNote = useMutation({
    mutationFn: () =>
      api.post(`/clients/${clientId}/activities`, {
        body: note.trim(),
        kind: 'note',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['client', clientId] })
      setNote('')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <Card className='h-fit crate-card'>
      <CardHeader>
        <CardTitle className='pb-2 display text-lg crate-rule'>
          Activity
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-4'>
        <div className='space-y-2'>
          <Textarea
            id='activity-note'
            name='activity-note'
            aria-label='Log an activity'
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='Log a call, a meeting, or a note…'
            className='min-h-16 resize-y'
          />
          <Button
            size='sm'
            onClick={() => addNote.mutate()}
            disabled={!note.trim() || addNote.isPending}
          >
            Add note
          </Button>
        </div>

        {timeline.length === 0 ? (
          <p className='text-sm text-muted-foreground'>Nothing logged yet.</p>
        ) : (
          <ol className='space-y-3'>
            {timeline.map((entry) => (
              <li key={entry.id} className='flex gap-2.5'>
                <span className='mt-0.5 shrink-0'>
                  {entry.kind === 'status_change' ? (
                    <ArrowRightLeft className='size-3.5 text-muted-foreground' />
                  ) : (
                    <MessageSquare className='size-3.5 text-muted-foreground' />
                  )}
                </span>
                <div className='min-w-0'>
                  <p className='text-sm break-words'>{entry.body}</p>
                  <p className='text-xs text-muted-foreground'>
                    {new Date(entry.occurredAt).toLocaleString('en-GB', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                    {entry.actorName ? ` · ${entry.actorName}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Links, files, to-dos and the moodboard for one client, on the agency side.
 *
 * Fetches the same `/api/portal?client=` payload the homepage does rather than
 * widening `/api/clients/:id`, because the shapes must not diverge: the moment
 * this page had its own idea of what a workspace contains, the two screens
 * start disagreeing about the same client.
 */
function ClientWorkspace({
  clientId,
  section,
}: {
  clientId: string
  section: 'work' | 'files'
}) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['portal', clientId],
    queryFn: () => api.get<PortalWorkspace>(`/portal?client=${clientId}`),
  })

  if (isLoading) {
    return (
      <div className='grid gap-5 lg:grid-cols-2'>
        <Skeleton className='h-56' />
        <Skeleton className='h-56' />
      </div>
    )
  }

  if (isError || !data) {
    return (
      <QueryError
        title='Could not load this client&rsquo;s workspace'
        error={error as Error}
        onRetry={() => refetch()}
      />
    )
  }

  // One query, two tabs. Both sections read ['portal', clientId], so the second
  // one costs nothing and neither can show a different workspace from the
  // other — which is the whole reason this fetches the portal's own payload.
  if (section === 'work') {
    return <LinkStack links={data.links} canEdit clientId={clientId} />
  }

  return (
    <div className='grid items-start gap-5 lg:grid-cols-2'>
      <FileFolder files={data.files} canEdit clientId={clientId} />
      <TaskList tasks={data.tasks} canEdit clientId={clientId} />
    </div>
  )
}
