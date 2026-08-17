import {
  LayoutDashboard,
  Building2,
  KanbanSquare,
  Home,
  CalendarDays,
  Lightbulb,
  Grid3x3,
  Palette,
  Settings,
  UserCog,
  Bell,
  Monitor,
  Paintbrush,
} from 'lucide-react'
import { type SidebarData } from '../types'

/**
 * Navigation is split by audience:
 *
 *  - "Agency" is staff-only. Client-role sessions must never see these entries,
 *    and the API enforces that independently — hiding nav is presentation, not
 *    security. Pipeline in particular exposes deal values.
 *  - "Client Workspace" mirrors the five sections of her original portal, in
 *    her order: Homepage, Content Calendar, Ideas Bank, Feed Preview, Moodboard.
 */
export const sidebarData: SidebarData = {
  user: {
    name: 'Banana Digital',
    email: 'hello@bananadigital.london',
    avatar: '/images/favicon.png',
  },
  navGroups: [
    {
      title: 'Agency',
      staffOnly: true,
      items: [
        { title: 'Dashboard', url: '/', icon: LayoutDashboard },
        { title: 'Clients', url: '/clients', icon: Building2 },
        { title: 'Pipeline', url: '/pipeline', icon: KanbanSquare },
      ],
    },
    {
      title: 'Client Workspace',
      items: [
        { title: 'Homepage', url: '/portal', icon: Home },
        { title: 'Content Calendar', url: '/portal/calendar', icon: CalendarDays },
        { title: 'Ideas Bank', url: '/portal/ideas', icon: Lightbulb },
        { title: 'Feed Preview', url: '/portal/feed', icon: Grid3x3 },
        { title: 'Social Moodboard', url: '/portal/moodboard', icon: Palette },
      ],
    },
    {
      title: 'Other',
      items: [
        {
          title: 'Settings',
          icon: Settings,
          items: [
            { title: 'Profile', url: '/settings', icon: UserCog },
            { title: 'Account', url: '/settings/account', icon: Paintbrush },
            { title: 'Appearance', url: '/settings/appearance', icon: Palette },
            { title: 'Notifications', url: '/settings/notifications', icon: Bell },
            { title: 'Display', url: '/settings/display', icon: Monitor },
          ],
        },
      ],
    },
  ],
}
