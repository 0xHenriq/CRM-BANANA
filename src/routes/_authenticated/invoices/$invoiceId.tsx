import { createFileRoute } from '@tanstack/react-router'
import { InvoiceDocument } from '@/features/invoices/document'

/**
 * The invoice, as the document she sends.
 *
 * Deliberately NOT behind `requireStaffRoute`. A client opens this to read
 * what they are being charged and to pay it, which is the whole point of
 * having it — and there is nothing to guard in the route anyway: RLS gates
 * `invoices` on `issued_on`, so a draft is simply not found for them, and one
 * belonging to another client is not found either.
 */
export const Route = createFileRoute('/_authenticated/invoices/$invoiceId')({
  component: InvoiceDocument,
})
