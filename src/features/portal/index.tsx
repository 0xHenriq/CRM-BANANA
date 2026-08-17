import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PageHead } from '@/components/layout/page-head'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { ThemeSwitch } from '@/components/theme-switch'
import { Card, CardContent } from '@/components/ui/card'
import { useCurrentUser } from '@/hooks/use-current-user'

/**
 * Client workspace homepage.
 *
 * Phase 4 builds this out: the Link Stack (as real anchors), File Folder with
 * uploads, threaded Notice Board, and Tasks. This stub exists so client-role
 * users have somewhere of their own to land rather than the agency dashboard.
 */
export function PortalHome() {
  const { data: user } = useCurrentUser()

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
        <PageHead
          eyebrow='Welcome to your social hub'
          title='Homepage'
          stamp={{ top: 'EST.', big: 'BD', bottom: 'LDN' }}
        />

        <Card className='crate-card'>
          <CardContent className='py-8'>
            <p className='text-sm text-muted-foreground'>
              {user ? `Signed in as ${user.name}. ` : ''}
              Your link stack, files, notice board and to-do&rsquo;s appear here.
            </p>
          </CardContent>
        </Card>
      </Main>
    </>
  )
}
