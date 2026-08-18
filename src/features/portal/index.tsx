import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type PortalWorkspace } from '@/lib/api'
import { useCurrentUser } from '@/hooks/use-current-user'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PageHead } from '@/components/layout/page-head'
import { QueryError } from '@/components/layout/query-error'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { ThemeSwitch } from '@/components/theme-switch'
import { LinkStack } from './link-stack'
import { FileFolder, NoticeBoard, TaskList } from './panels'

/**
 * The client workspace homepage — the screen her clients actually live in.
 *
 * Both audiences render the same component. Staff get a workspace switcher and
 * edit controls; a client gets neither, and the API returns them a narrower
 * set of rows regardless (internal tasks never leave the database). Two
 * separate components would have drifted into two different products.
 */
export function PortalHome() {
  const { data: currentUser } = useCurrentUser()
  const isStaff = currentUser?.isStaff ?? false
  const [selected, setSelected] = useState<string | null>(null)

  // Staff can browse any open workspace; a client has exactly one and the
  // server decides which, so this query is skipped for them entirely.
  const workspaces = useQuery({
    queryKey: ['portal-workspaces'],
    queryFn: () =>
      api.get<{ workspaces: { id: string; name: string }[] }>(
        '/portal/workspaces'
      ),
    enabled: isStaff,
  })

  const query = useQuery({
    queryKey: ['portal', selected ?? 'default'],
    queryFn: () =>
      api.get<PortalWorkspace>(
        selected ? `/portal?client=${selected}` : '/portal'
      ),
    enabled: currentUser !== undefined,
  })

  const chrome = (
    <Header>
      <div className='ms-auto flex items-center gap-2'>
        {isStaff && (workspaces.data?.workspaces.length ?? 0) > 0 && (
          <Select
            value={selected ?? query.data?.client.id ?? ''}
            onValueChange={setSelected}
          >
            <SelectTrigger className='h-8 w-48' aria-label='Client workspace'>
              <SelectValue placeholder='Choose a workspace' />
            </SelectTrigger>
            <SelectContent>
              {workspaces.data?.workspaces.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
  const clientId = client.id

  return (
    <>
      {chrome}
      <Main>
        <PageHead
          eyebrow='Welcome to your social hub'
          title='Homepage'
          stamp={{ top: 'EST.', big: 'BD', bottom: 'LDN' }}
          actions={
            <span className='display max-sm:hidden text-xl'>{client.name}</span>
          }
        />

        {isStaff && (
          <Card className='crate-card mb-5 border-dashed'>
            <CardContent className='py-3 text-xs text-muted-foreground'>
              You are viewing <strong>{client.name}</strong>&rsquo;s workspace as
              agency staff. Internal to-do&rsquo;s are marked; the client never
              receives those rows.
            </CardContent>
          </Card>
        )}

        <div className='grid items-start gap-5 lg:grid-cols-2'>
          <div className='space-y-5'>
            <LinkStack links={links} canEdit={isStaff} clientId={clientId} />
            <NoticeBoard
              notices={notices}
              clientId={clientId}
              canModerate={isStaff}
            />
          </div>
          <div className='space-y-5'>
            <FileFolder files={files} canEdit={isStaff} clientId={clientId} />
            <TaskList tasks={tasks} canEdit={isStaff} clientId={clientId} />
          </div>
        </div>
      </Main>
    </>
  )
}
