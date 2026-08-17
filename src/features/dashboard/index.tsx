import { Building2, CalendarDays, ClipboardCheck, Eye } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PageHead } from '@/components/layout/page-head'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'

/**
 * Agency overview.
 *
 * Deliberately shows em-dashes rather than numbers: these counts are wired to
 * real queries in Phase 3. Placeholder metrics that look real are worse than
 * visibly empty ones — they get screenshotted and believed.
 */
const stats = [
  { label: 'Active clients', icon: Building2, hint: 'Signed and onboarded' },
  { label: 'Awaiting review', icon: Eye, hint: 'Content sent to clients' },
  { label: 'Scheduled this month', icon: CalendarDays, hint: 'Posts on the calendar' },
  { label: 'Open to-dos', icon: ClipboardCheck, hint: 'Across all workspaces' },
]

export function Dashboard() {
  return (
    <>
      <Header>
        <Search />
        <div className='ms-auto flex items-center gap-2'>
          <ThemeSwitch />
          <ConfigDrawer />
          <ProfileDropdown />
        </div>
      </Header>

      <Main>
        <PageHead
          eyebrow='Agency overview'
          title='Dashboard'
          stamp={{ top: 'EST.', big: 'BD', bottom: 'LDN' }}
        />

        <div className='grid gap-5 sm:grid-cols-2 lg:grid-cols-4'>
          {stats.map(({ label, icon: Icon, hint }) => (
            <Card key={label} className='crate-card gap-0 py-5'>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 px-5 pb-2'>
                <CardTitle className='text-sm font-semibold'>{label}</CardTitle>
                <Icon className='size-4 text-muted-foreground' />
              </CardHeader>
              <CardContent className='px-5'>
                <div className='display text-3xl'>&mdash;</div>
                <p className='mt-1 text-xs text-muted-foreground'>{hint}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className='crate-card mt-6'>
          <CardHeader>
            <CardTitle className='display text-lg'>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            <p className='text-sm text-muted-foreground'>
              Client activity appears here once workspaces are live.
            </p>
          </CardContent>
        </Card>
      </Main>
    </>
  )
}
