import { useQuery } from '@tanstack/react-query'
import {
  api,
  outstandingPence,
  type Invoice,
  type PortalWorkspace,
} from '@/lib/api'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ClientLogo } from '@/components/client-logo'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PageHead } from '@/components/layout/page-head'
import { QueryError } from '@/components/layout/query-error'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { ThemeSwitch } from '@/components/theme-switch'
import { MoodboardPreview } from '@/features/content/moodboard-preview'
import { PostGrid } from '@/features/content/post-grid'
import { NextSteps } from '@/features/content/review-queue'
import { InvoicesPanel } from '@/features/invoices/panel'
import { CredentialsHub } from './credentials'
import { LinkStack } from './link-stack'
import { FileFolder, NoticeBoard, TaskList } from './panels'
import { useWorkspace, withClient } from './use-workspace'
import { WorkspaceSwitcher } from './workspace-switcher'

/**
 * The client workspace homepage — the screen her clients actually live in.
 *
 * Both audiences render the same component. Staff get a workspace switcher and
 * edit controls; a client gets neither, and the API returns them a narrower
 * set of rows regardless (internal tasks never leave the database). Two
 * separate components would have drifted into two different products.
 */
export function PortalHome() {
  const { isStaff, clientId, setClientId, workspaces, isReady } = useWorkspace()

  const query = useQuery({
    queryKey: ['portal', clientId ?? 'default'],
    queryFn: () => api.get<PortalWorkspace>(withClient('/portal', clientId)),
    enabled: isReady,
  })

  /*
   * Whether anything is actually owed, which decides where money sits.
   *
   * The SAME key InvoicesPanel reads, so this is not a second request — it is
   * the same cache entry, and one refetch moves both the panel and its
   * position. A separate endpoint answering "do they owe anything" would be a
   * second source of truth for the one number on this page that has to agree
   * with itself on both sides of the relationship.
   */
  const invoices = useQuery({
    queryKey: ['invoices', query.data?.client.id],
    queryFn: () =>
      api.get<{ invoices: Invoice[] }>(
        `/invoices?client=${query.data!.client.id}`
      ),
    enabled: Boolean(query.data?.client.id),
  })

  const chrome = (
    <Header>
      <div className='ms-auto flex items-center gap-2'>
        {isStaff && (
          <WorkspaceSwitcher
            clientId={clientId}
            workspaces={workspaces}
            onChange={setClientId}
          />
        )}
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
      </div>
    </Header>
  )

  if (query.isLoading) {
    return (
      <>
        {chrome}
        <Main>
          <Skeleton className='mb-6 h-20' />
          <div className='grid gap-5 lg:grid-cols-2'>
            <Skeleton className='h-64' />
            <Skeleton className='h-64' />
          </div>
        </Main>
      </>
    )
  }

  if (query.isError || !query.data) {
    return (
      <>
        {chrome}
        <Main>
          <PageHead eyebrow='Client workspace' title='Unavailable' />
          <QueryError
            title={
              isStaff
                ? 'No client workspace is open yet'
                : 'Your workspace is not available'
            }
            error={query.error as Error}
            onRetry={() => query.refetch()}
          />
        </Main>
      </>
    )
  }

  const { client, links, files, tasks, notices } = query.data
  // The workspace the server actually resolved — for a client this is their
  // own, and for staff it matches the switcher.
  const workspaceId = client.id

  /*
   * Money leads only when there is money outstanding.
   *
   * Two of Sofia's requests point in opposite directions and both are right.
   * The first — "a client owes her 5k, so it should be visually on top of
   * their homepage" — is about the case where something is owed. The second —
   * "I want their first page they see to be the work tab" — is about every
   * other day, when the invoice panel reading "Nothing outstanding" was the
   * first thing a client saw on a page that is supposed to be about the work.
   *
   * So the rule is the fact rather than the layout: if they owe something it
   * goes above everything, and if they do not it sits below the work where it
   * is still one scroll away. Nothing is hidden in either case.
   *
   * `undefined` while the query is in flight is treated as "does not lead",
   * which is the quiet answer — the panel arriving and then jumping to the top
   * would be worse than it appearing where it ends up.
   */
  const owesMoney = (invoices.data?.invoices ?? []).some(
    (invoice) => outstandingPence(invoice) > 0
  )

  const moneyPanel = (
    <div className='mb-5'>
      <InvoicesPanel clientId={workspaceId} canEdit={isStaff} />
    </div>
  )

  return (
    <>
      {chrome}
      <Main>
        <PageHead
          eyebrow='Welcome to your social hub'
          title='Homepage'
          stamp={{ top: 'EST.', big: 'BD', bottom: 'LDN' }}
          actions={
            <ClientLogo
              clientId={client.id}
              name={client.name}
              logoKey={client.logoKey}
              brandColor={client.brandColor}
              canEdit={isStaff}
            />
          }
        />

        {/*
          Above everything: the reason they opened the portal, if there is one.
          Buried below a link stack it may as well not exist.

          SCOPED to this workspace. Without the id it loads every client's next
          steps, which for a client is invisible — RLS gives them their own
          either way — but meant that staff opening one client's homepage got a
          panel listing nine other clients' work. On the page that is entirely
          about this client, that is the one thing it must not be.
        */}
        <NextSteps
          variant={isStaff ? 'agency' : 'client'}
          clientId={workspaceId}
        />

        {/* Only when they owe something — see `owesMoney` above. */}
        {owesMoney && moneyPanel}

        {/*
          The work, which is what they came for.

          Sofia asked for "a page feed of approved one" on the portal, and for
          the client's first screen to be the work rather than the admin around
          it. This is that feed: the approved and scheduled posts as pictures,
          soonest first, in the same square tiles as the Feed Preview.
        */}
        <PostGrid clientId={workspaceId} mode='upcoming' className='mb-5' />

        {/*
          Then the visual direction: the thing a social client actually opens
          the portal to see, and it was behind a nav item they had to know to
          click.
        */}
        <MoodboardPreview clientId={workspaceId} canEdit={isStaff} />

        {/*
          What the work is for.

          She was keeping the brief to herself and asked for that to change —
          "I want client to see project brief too". It sits above tone of
          voice because it is the bigger thing: the brief is what they agreed
          to, the tone is how it should sound.

          Absent rather than empty when she has not written one.
        */}
        {client.brief && (
          <Card className='mb-5 crate-card'>
            <CardHeader>
              <CardTitle className='flex items-center gap-2 display text-lg'>
                <span className='size-2.5 rounded-full border-[1.5px] border-bd-ink bg-bd-yellow' />
                Project brief
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className='mb-3 crate-rule' />
              <p className='text-sm whitespace-pre-wrap'>{client.brief}</p>
            </CardContent>
          </Card>
        )}

        {/*
          How they want to sound, shown back to them.

          She writes it on the client page; this is the half that makes it
          worth writing — the client reads it and says "no, warmer than that",
          which is the correction that otherwise arrives three posts in.
          Absent rather than empty when she has not written one: a card headed
          "Tone of voice" with nothing under it invites them to wonder whether
          she forgot.
        */}
        {client.toneOfVoice && (
          <Card className='mb-5 crate-card'>
            <CardHeader>
              <CardTitle className='flex items-center gap-2 display text-lg'>
                <span className='size-2.5 rounded-full border-[1.5px] border-bd-ink bg-tag-story' />
                Tone of voice
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className='mb-3 crate-rule' />
              <p className='text-sm whitespace-pre-wrap'>
                {client.toneOfVoice}
              </p>
            </CardContent>
          </Card>
        )}

        {isStaff && (
          <Card className='mb-5 crate-card border-dashed'>
            <CardContent className='py-3 text-xs text-muted-foreground'>
              You are viewing <strong>{client.name}</strong>&rsquo;s workspace
              as agency staff. Internal to-do&rsquo;s are marked; the client
              never receives those rows.
            </CardContent>
          </Card>
        )}

        {/* Settled: the panel still belongs on this page, just not at the top. */}
        {!owesMoney && moneyPanel}

        <div className='grid items-start gap-5 lg:grid-cols-2'>
          <div className='space-y-5'>
            <LinkStack links={links} canEdit={isStaff} clientId={workspaceId} />
            <NoticeBoard
              notices={notices}
              clientId={workspaceId}
              canModerate={isStaff}
            />
          </div>
          <div className='space-y-5'>
            <FileFolder
              files={files}
              canEdit={isStaff}
              clientId={workspaceId}
            />
            <TaskList tasks={tasks} canEdit={isStaff} clientId={workspaceId} />
          </div>
        </div>

        {/*
          The password hub, last, and on the CLIENT's own page as well as hers.
          
          "Client can fill in social media passwords" was the request, and this
          is the screen they are already signed into. Bottom of the page on
          purpose: it is a thing you come here to do once, not something that
          should be competing with the work every time they open the portal.
        */}
        <div className='mt-5'>
          <CredentialsHub clientId={workspaceId} />
        </div>
      </Main>
    </>
  )
}
