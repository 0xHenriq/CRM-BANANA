import { useLayout } from '@/context/layout-provider'
import { useCurrentUser } from '@/hooks/use-current-user'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar'
import { AppTitle } from './app-title'
import { sidebarData } from './data/sidebar-data'
import { NavGroup } from './nav-group'
import { NavUser } from './nav-user'

export function AppSidebar() {
  const { collapsible, variant } = useLayout()
  const { data: currentUser } = useCurrentUser()

  // Hiding agency nav from a client is courtesy, not security — the RLS
  // policies are what stop them reading deals. Default to hiding while the
  // user is still loading, so staff-only items never flash for a client.
  const isStaff = currentUser?.isStaff ?? false
  const groups = sidebarData.navGroups.filter((g) => !g.staffOnly || isStaff)

  return (
    <Sidebar collapsible={collapsible} variant={variant}>
      <SidebarHeader>
        <AppTitle />
      </SidebarHeader>
      <SidebarContent>
        {groups.map((props) => (
          <NavGroup key={props.title} {...props} />
        ))}
      </SidebarContent>
      <SidebarFooter>
        <NavUser
          user={
            currentUser
              ? {
                  name: currentUser.name,
                  email: currentUser.email,
                  avatar: '/images/favicon.png',
                }
              : sidebarData.user
          }
        />
        <div className='px-2 pb-1 text-[0.625rem] leading-relaxed tracking-wide opacity-50'>
          <span className='font-semibold'>Banana Digital London</span>
          <br />
          Social &amp; content partner
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
