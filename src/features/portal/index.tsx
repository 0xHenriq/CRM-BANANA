import { useQuery } from '@tanstack/react-query'
import { api, type PortalWorkspace } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
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
import { ReviewQueue } from '@/features/content/review-queue'
import { InvoicesPanel } from '@/features/invoices/panel'
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

        {/* Above everything: the reason they opened the portal, if there is
            one. Buried below a link stack it may as well not exist. */}
        <ReviewQueue variant={isStaff ? 'agency' : 'client'} />

        {/*
          Money first. "A client owes her 5k, so it should be visually on top
          of their homepage" — and it is the one thing on this screen where
          both sides need to be looking at the same number.
        */}
        <div className='mb-5'>
          <InvoicesPanel clientId={workspaceId} canEdit={isStaff} />
        </div>

        {/*
          Then the visual direction: the thing a social client actually opens
          the portal to see, and it was behind a nav item they had to know to
          click.
        */}
        <MoodboardPreview clientId={workspaceId} canEdit={isStaff} />

        {isStaff && (
          <Card className='mb-5 crate-card border-dashed'>
            <CardContent className='py-3 text-xs text-muted-foreground'>
              You are viewing <strong>{client.name}</strong>&rsquo;s workspace
              as agency staff. Internal to-do&rsquo;s are marked; the client
              never receives those rows.
            </CardContent>
          </Card>
        )}

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
      </Main>
    </>
  )
}
