import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeft, CreditCard, Loader2, Printer, Send } from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  ApiError,
  formatPence,
  formatShortDate,
  invoiceState,
  localDayOf,
  outstandingPence,
  type InvoiceDetail,
} from '@/lib/api'
import { copyText } from '@/lib/copy-text'
import { cn } from '@/lib/utils'
import { useCurrentUser } from '@/hooks/use-current-user'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { QueryError } from '@/components/layout/query-error'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { ThemeSwitch } from '@/components/theme-switch'
import { InvoiceStatePill } from './panel'

/**
 * The invoice as a document, in her layout.
 *
 * Sofia sent a photograph of a real Banana Digital invoice — wordmark, BILL
 * TO block, itemised description, totals, payment method, payment condition,
 * "Thank you for your business" — and asked whether "stripe could generate
 * invoices like this".
 *
 * Stripe cannot, and it is worth being plain about why rather than half
 * building it: Stripe's hosted invoice is Stripe's document with a logo
 * dropped into the corner, and its line items, wording and terms are theirs.
 * What she is holding in that photograph is her own document. So it is
 * rendered here from the invoice we already store, and Stripe keeps the job it
 * is actually good at — taking the card. The Pay button on this page is the
 * same Checkout endpoint the panel uses, so a card payment still lands as a
 * receipt through `recordPayment` and there is one set of money rules.
 *
 * The PDF is the browser's. `window.print()` on a sheet with print styles
 * produces the file, which avoids a PDF dependency, a font-embedding problem
 * and a second layout that would drift from this one within a month.
 */
export function InvoiceDocument() {
  const { invoiceId } = useParams({
    from: '/_authenticated/invoices/$invoiceId',
  })
  const { data: currentUser } = useCurrentUser()
  const isStaff = Boolean(currentUser?.isStaff)

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => api.get<InvoiceDetail>(`/invoices/${invoiceId}`),
  })

  /**
   * The same endpoint as the panel's two buttons, and the same split.
   *
   * For her it produces a link to send — she is not the one paying, and
   * opening Stripe in her own browser is never what she wanted. For the client
   * it is the page they pay on.
   */
  const checkout = useMutation({
    mutationFn: () =>
      api.post<{ url: string; amountPence: number; number: string }>(
        `/invoices/${invoiceId}/checkout`,
        {}
      ),
    onSuccess: async (result) => {
      if (isStaff) {
        const ok = await copyText(result.url)
        toast[ok ? 'success' : 'error'](
          ok
            ? `Payment link for ${result.number} copied — ${formatPence(result.amountPence, 'GBP')}. Send it to them.`
            : `Link created but the copy failed. It is ${result.url}`,
          { duration: ok ? 6000 : 30000 }
        )
      } else {
        window.location.href = result.url
      }
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const chrome = (
    <Header>
      <div className='ms-auto flex items-center gap-2'>
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
      </div>
    </Header>
  )

  if (isError) {
    return (
      <>
        {chrome}
        <Main>
          <QueryError
            title={
              error instanceof ApiError && error.status === 404
                ? 'That invoice does not exist, or it has not been issued yet.'
                : 'Could not load this invoice'
            }
            error={error as Error}
            onRetry={() => refetch()}
          />
        </Main>
      </>
    )
  }

  if (isPending) {
    return (
      <>
        {chrome}
        <Main>
          <Skeleton className='h-[40rem] max-w-3xl' />
        </Main>
      </>
    )
  }

  const { invoice, payments, settings } = data
  const outstanding = outstandingPence(invoice)
  const state = invoiceState(invoice)
  const paid = invoice.paidPence

  return (
    <>
      {chrome}
      <Main>
        {/* Everything here is an action, so none of it prints. */}
        <div className='print-hide mb-4 flex flex-wrap items-center gap-2'>
          {/*
            Back to where the reader came from, which is not the same place
            for the two audiences. `/clients/:id` is staff-only and a client
            following it is bounced to their portal — a link that visibly does
            something other than what it says.
          */}
          <Button variant='outline' size='sm' asChild>
            {isStaff ? (
              <Link
                to='/clients/$clientId'
                params={{ clientId: invoice.clientId }}
                search={{ tab: 'money' }}
              >
                <ArrowLeft />
                {invoice.clientName}
              </Link>
            ) : (
              <Link to='/portal'>
                <ArrowLeft />
                Your workspace
              </Link>
            )}
          </Button>
          <InvoiceStatePill invoice={invoice} />
          <div className='ms-auto flex flex-wrap items-center gap-2'>
            <Button variant='outline' size='sm' onClick={() => window.print()}>
              <Printer />
              Print or save as PDF
            </Button>
            {outstanding > 0 && (
              <Button
                size='sm'
                onClick={() => checkout.mutate()}
                disabled={checkout.isPending}
              >
                {checkout.isPending ? (
                  <Loader2 className='animate-spin' />
                ) : isStaff ? (
                  <Send />
                ) : (
                  <CreditCard />
                )}
                {isStaff
                  ? 'Copy a payment link'
                  : `Pay ${formatPence(outstanding, invoice.currency)}`}
              </Button>
            )}
          </div>
        </div>

        {/*
          The sheet. `invoice-sheet` is what the print rules keep visible, so
          the class is load-bearing rather than decorative — see index.css.
        */}
        <article className='invoice-sheet mx-auto max-w-3xl border-2 border-bd-ink bg-bd-paper p-8 sm:p-10'>
          <header className='flex flex-wrap items-start justify-between gap-6'>
            <div>
              <p className='display text-2xl leading-none'>BANANA DIGITAL</p>
              <p className='text-[0.6875rem] tracking-[0.18em] text-muted-foreground uppercase'>
                London
              </p>
            </div>
            <p className='display text-4xl leading-none'>INVOICE</p>
          </header>

          {/*
            A draft or a voided invoice has to say so ON THE PAPER.

            The status pill sits in the toolbar above, which is `print-hide` —
            so a voided invoice printed as an ordinary one, and she could send
            a demand for money she had already withdrawn. A draft is worse
            still: it carries figures she has not agreed to charge yet and no
            issue date, and the document would present them as final.
          */}
          {(state === 'draft' || state === 'void') && (
            <p
              className={cn(
                'mt-4 border-[1.5px] border-bd-ink px-3 py-2 text-center',
                'display text-lg',
                state === 'void' ? 'bg-pay-overdue text-white' : 'bg-bd-sand'
              )}
            >
              {state === 'void'
                ? 'VOID — this invoice has been withdrawn and is not owed'
                : 'DRAFT — not issued, and not visible to the client'}
            </p>
          )}

          <div className='my-6 crate-rule' />

          <div className='grid gap-6 sm:grid-cols-2'>
            <section>
              <h2 className='crate-eyebrow'>Bill to</h2>
              {/*
                Her billing address, printed verbatim, falling back to the
                client's name. A blank block on a document somebody is meant to
                pay against reads as a mistake in the document rather than as a
                field she has not filled in yet.
              */}
              <p className='mt-1 text-sm whitespace-pre-wrap'>
                {invoice.clientBillingAddress?.trim() || invoice.clientName}
              </p>
            </section>

            <section className='sm:text-end'>
              <h2 className='crate-eyebrow'>Invoice number</h2>
              <p className='mt-1 font-mono text-sm'>{invoice.number}</p>
              <p className='mt-2 text-sm'>
                <span className='text-muted-foreground'>Date: </span>
                {/* localDayOf on the fallback: `createdAt` is a timestamp and
                    slicing it takes the UTC day, which dates a document raised
                    late one evening in London to the day before. `issuedOn` is
                    already a plain date and needs no conversion. */}
                {formatShortDate(invoice.issuedOn ?? localDayOf(invoice.createdAt))}
              </p>
              {invoice.dueOn && (
                <p className='text-sm'>
                  <span className='text-muted-foreground'>Due: </span>
                  {formatShortDate(invoice.dueOn)}
                </p>
              )}
            </section>
          </div>

          {settings.paymentMethod.trim() && (
            <section className='mt-6'>
              <h2 className='crate-eyebrow'>Payment method</h2>
              <p className='mt-1 text-sm whitespace-pre-wrap'>
                {settings.paymentMethod}
              </p>
            </section>
          )}

          <section className='mt-8'>
            <h2 className='crate-eyebrow'>Item description</h2>
            <div className='mt-2 overflow-x-auto'>
              <table className='w-full border-collapse text-sm'>
                <thead>
                  <tr className='border-y-2 border-bd-ink text-start'>
                    <th className='py-1.5 pe-3 text-start text-[0.625rem] font-bold tracking-[0.1em] uppercase'>
                      No
                    </th>
                    <th className='py-1.5 pe-3 text-start text-[0.625rem] font-bold tracking-[0.1em] uppercase'>
                      Description
                    </th>
                    <th className='py-1.5 pe-3 text-end text-[0.625rem] font-bold tracking-[0.1em] uppercase'>
                      Price
                    </th>
                    <th className='py-1.5 pe-3 text-end text-[0.625rem] font-bold tracking-[0.1em] uppercase'>
                      Qty
                    </th>
                    <th className='py-1.5 text-end text-[0.625rem] font-bold tracking-[0.1em] uppercase'>
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {/*
                    ONE line, and that is not a shortcut — it is what an
                    invoice in this system is. `invoices.amount_pence` is a
                    single integer, and the real one she sent has exactly one
                    numbered item whose description runs to a paragraph and a
                    list. Splitting the money across several rows would need a
                    line-items table and a second answer to "what is owed",
                    which is the one number both sides have to agree on.

                    The description keeps its line breaks, so the numbered
                    pages and the bullets she types survive to the document.
                  */}
                  <tr className='border-b border-bd-rule align-top'>
                    <td className='py-3 pe-3 font-bold tabular-nums'>1</td>
                    <td className='py-3 pe-3'>
                      <p className='font-semibold'>
                        {invoice.description?.split('\n')[0] ||
                          'Professional services'}
                      </p>
                      {invoice.description?.includes('\n') && (
                        <p className='mt-1 text-xs whitespace-pre-wrap text-muted-foreground'>
                          {invoice.description.slice(
                            invoice.description.indexOf('\n') + 1
                          )}
                        </p>
                      )}
                    </td>
                    <td className='py-3 pe-3 text-end tabular-nums'>
                      {formatPence(invoice.amountPence, invoice.currency)}
                    </td>
                    <td className='py-3 pe-3 text-end tabular-nums'>1</td>
                    <td className='py-3 text-end tabular-nums'>
                      {formatPence(invoice.amountPence, invoice.currency)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className='mt-6 flex justify-end'>
            <dl className='w-full max-w-xs space-y-1 text-sm'>
              <Row
                label='Sub total'
                value={formatPence(invoice.amountPence, invoice.currency)}
              />
              {/*
                Paid and outstanding appear only when there is something to
                say. A "Paid: £0.00" line on a fresh invoice invites the reader
                to check it, and there is nothing there to check.
              */}
              {paid > 0 && (
                <Row
                  label='Paid'
                  value={`− ${formatPence(paid, invoice.currency)}`}
                />
              )}
              {/*
                "Still owed" only when something is. Keyed on `outstanding`
                rather than on `paid > 0`, which read "Still owed £0.00" on a
                settled invoice — a bottom line of zero on the one line the
                reader looks at first, under a heading that says money is due.
              */}
              <div className='mt-1 flex items-baseline justify-between border-t-2 border-bd-ink pt-1.5'>
                <dt className='display text-lg'>
                  {outstanding > 0 && paid > 0 ? 'Still owed' : 'Total'}
                </dt>
                <dd className='display text-lg tabular-nums'>
                  {formatPence(
                    outstanding > 0 && paid > 0
                      ? outstanding
                      : invoice.amountPence,
                    invoice.currency
                  )}
                </dd>
              </div>
              {state === 'paid' && (
                <p className='text-end text-xs font-bold text-pay-paid'>
                  Paid in full — thank you.
                </p>
              )}
            </dl>
          </section>

          {payments.length > 0 && (
            <section className='mt-6'>
              <h2 className='crate-eyebrow'>Receipts</h2>
              <ul className='mt-1 space-y-0.5 text-xs text-muted-foreground'>
                {payments.map((payment) => (
                  <li key={payment.id} className='flex justify-between gap-3'>
                    <span>
                      {payment.receiptNumber} ·{' '}
                      {formatShortDate(payment.paidOn)}
                      {payment.method ? ` · ${payment.method}` : ''}
                    </span>
                    <span className='tabular-nums'>
                      {formatPence(payment.amountPence, invoice.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {settings.paymentTerms.trim() && (
            <section className='mt-8 border-t border-bd-rule pt-4 text-center'>
              <h2 className='display text-base'>Payment condition</h2>
              <p className='mt-1 text-xs whitespace-pre-wrap'>
                {settings.paymentTerms}
              </p>
            </section>
          )}

          {invoice.notes?.trim() && (
            <section className='mt-4 text-xs text-muted-foreground'>
              <p className='whitespace-pre-wrap'>{invoice.notes}</p>
            </section>
          )}

          <p className='mt-8 text-center text-sm'>
            {settings.footer.trim() || 'Thank you for your business. 🍌'}
          </p>
        </article>

        {isStaff && <InvoiceSettingsEditor settings={settings} />}
      </Main>
    </>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex items-baseline justify-between'>
      <dt className='text-muted-foreground'>{label}</dt>
      <dd className='tabular-nums'>{value}</dd>
    </div>
  )
}

/**
 * The three blocks that are the same on every invoice.
 *
 * Edited HERE, below the document, because this is where you notice a sort
 * code is wrong — not on a settings page you would have to remember to go and
 * look at. Staff only, and it never prints.
 *
 * Stored in `system_meta` rather than in the repository or the environment:
 * this repo is public, and an account number is not a credential but there is
 * no reason to publish it.
 */
function InvoiceSettingsEditor({
  settings,
}: {
  settings: InvoiceDetail['settings']
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(settings)

  const save = useMutation({
    mutationFn: () => api.patch('/invoices/settings', form),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['invoice'] })
      toast.success('Saved. It appears on every invoice from now on.')
      setOpen(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  if (!open) {
    return (
      <div className='print-hide mx-auto mt-4 max-w-3xl'>
        <Button variant='ghost' size='sm' onClick={() => setOpen(true)}>
          Edit the payment details on every invoice
        </Button>
      </div>
    )
  }

  return (
    <form
      className='print-hide mx-auto mt-4 max-w-3xl space-y-3 rounded-md border-[1.5px] border-dashed border-bd-rule p-4'
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <p className='text-xs text-muted-foreground'>
        These three blocks appear on <strong>every</strong> invoice, yours and
        past ones. They are stored on the server, not in the app&rsquo;s code.
      </p>

      <div className='grid gap-1.5'>
        <Label htmlFor='inv-method'>Payment method</Label>
        <Textarea
          id='inv-method'
          className='min-h-20 resize-y font-mono text-xs'
          placeholder={'Banana Digital London\nAccount 00-00-00 12345678'}
          value={form.paymentMethod}
          onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}
        />
      </div>

      <div className='grid gap-1.5'>
        <Label htmlFor='inv-terms'>Payment condition</Label>
        <Textarea
          id='inv-terms'
          className='min-h-20 resize-y'
          placeholder='Payment must be made before development starts.'
          value={form.paymentTerms}
          onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })}
        />
      </div>

      <div className='grid gap-1.5'>
        <Label htmlFor='inv-footer'>Closing line</Label>
        <Input
          id='inv-footer'
          placeholder='Thank you for your business. 🍌'
          value={form.footer}
          onChange={(e) => setForm({ ...form, footer: e.target.value })}
        />
      </div>

      <div className='flex gap-2'>
        <Button size='sm' disabled={save.isPending}>
          {save.isPending && <Loader2 className='animate-spin' />}
          Save
        </Button>
        <Button
          type='button'
          size='sm'
          variant='ghost'
          onClick={() => {
            setForm(settings)
            setOpen(false)
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
