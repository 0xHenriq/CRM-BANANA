import { createFileRoute } from '@tanstack/react-router'
import { SharePage } from '@/features/share'

/**
 * The one page in this application with no session behind it.
 *
 * A parenthesised route group is a SIBLING of `_authenticated`, not a child,
 * so it skips that layout's `beforeLoad` entirely — which is the point: the
 * recipient has no account and never will. Their only authority is the token
 * in this URL.
 */
export const Route = createFileRoute('/(share)/share/$token')({
  component: SharePage,
})
