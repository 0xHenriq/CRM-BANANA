import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  CreditCard,
  FileText,
  Loader2,
  Paperclip,
  Plus,
  Receipt,
  Send,
  Trash2,
  Ban,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  formatPence,
  invoiceState,
  outstandingPence,
  type Invoice,
  type InvoicePayment,
  type InvoiceState,
  fileUrl,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryError } from '@/components/layout/query-error'
import { UploadButton } from '@/components/upload-button'
import { uploadMedia } from '@/lib/upload'
import { copyText } from '@/lib/copy-text'

/**
 * How each state reads.
 *
 * Paid, overdue and awaiting reuse the bright payment tokens so money looks the
 * same everywhere in the product. Draft is deliberately quiet — it is her
 * working copy and the client cannot see it at all.
 */
const STATE_TONE: Record<InvoiceState, string> = {
  paid: 'bg-pay-paid text-white',
  overdue: 'bg-pay-overdue text-white',
  part_paid: 'bg-pay-awaiting text-bd-ink',
  sent: 'bg-pay-awaiting text-bd-ink',
  draft: 'bg-bd-sand text-bd-ink',
  void: 'bg-bd-rule text-bd-graphite',
}

const STATE_LABEL: Record<InvoiceState, string> = {
  paid: 'Paid',
  overdue: 'Overdue',
  part_paid: 'Part paid',
  sent: 'Awaiting',
  draft: 'Draft',
  void: 'Void',
}

export function InvoiceStatePill({ invoice }: { invoice: Invoice }) {
  const state = invoiceState(invoice)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded border-[1.5px] border-bd-ink px-1.5 py-0.5',
        'text-[0.625rem] font-bold whitespace-nowrap',
        STATE_TONE[state]
      )}
    >
      {STATE_LABEL[state]}
      {state === 'part_paid' &&
        ` · ${formatPence(outstandingPence(invoice), invoice.currency)} left`}
      {state === 'overdue' && invoice.dueOn && ` · ${invoice.dueOn}`}
    </span>
  )
}

/**
 * Money between her and one client.
 *
 * The same component for both audiences, deliberately: staff get the raise,
 * issue, record-payment and void controls, a client gets the same list without
 * them. Two components would have drifted into two different accounts of what
 * is owed, which is the one thing that must read identically on both sides —
 * "so both are aligned" was the entire request.
 *
 * A client never sees a draft at all: RLS gates on `issued_on`, so the rows do
 * not leave the database rather than being filtered here.
 */
export function InvoicesPanel({
  clientId,
  canEdit,
}: {
  clientId: string
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const [raising, setRaising] = useState(false)
  const [payingFor, setPayingFor] = useState<Invoice | null>(null)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['invoices', clientId],
    queryFn: () =>
      api.get<{ invoices: Invoice[] }>(`/invoices?client=${clientId}`),
  })

  /**
   * Both keys, because there are two.
   *
   * The list reads ['invoices', …] and the payment dialog reads ['invoice',
   * id] for that invoice's receipts. Prefix matching is element-wise, so
   * 'invoices' does not match 'invoice' — recording a payment refreshed the
   * list and left the receipts list beside it a version behind, showing her
   * one fewer receipt than the invoice had. Same trap as ['client'] versus
   * ['clients'] on the pipeline board.
   */
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['invoices'] })
    queryClient.invalidateQueries({ queryKey: ['invoice'] })
  }

  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: string; status?: string }) =>
      api.patch(`/invoices/${id}`, body),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  })

  /**
   * The invoice's own document.
   *
   * `target: 'file'` with an invoiceId, not a target of its own: an invoice
   * attachment IS a file, so it gets the same document allowlist, the same row
   * and the same File Folder listing — one set of bytes read from two places
   * rather than two that can drift.
   */
  const attach = useMutation({
    mutationFn: async ({
      invoiceId,
      file,
    }: {
      invoiceId: string
      file: File
    }) => {
      await uploadMedia(file, {
        clientId: null,
        target: 'file',
        invoiceId,
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['invoices'] })
      // The document lands in the File Folder too, which reads ['portal'].
      await queryClient.invalidateQueries({ queryKey: ['portal'] })
      toast.success('Attached. It appears on the invoice and in the File Folder.')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  /**
   * A Stripe payment page for what is still owed.
   *
   * One endpoint, two buttons. For her it produces a link to send; for the
   * client it is the page they pay on. Which one you get is decided by who is
   * signed in, not by a flag — RLS will not show a client an unissued draft,
   * so there is nothing to guard here.
   */
  const checkout = useMutation({
    mutationFn: (invoiceId: string) =>
      api.post<{ url: string; amountPence: number; number: string }>(
        `/invoices/${invoiceId}/checkout`,
        {}
      ),
    onSuccess: async (result) => {
      if (canEdit) {
        // Hers: a link to send. Copied rather than opened — she is not the one
        // paying, and opening Stripe in her own browser is never what she
        // wanted.
        const ok = await copyText(result.url)
        toast[ok ? 'success' : 'error'](
          ok
            ? `Payment link for ${result.number} copied — ${formatPence(result.amountPence, 'GBP')}. Send it to them.`
            : `Link created but the copy failed. It is ${result.url}`,
          { duration: ok ? 6000 : 30000 }
        )
      } else {
        // Theirs: go and pay. Same tab, because Stripe comes back here.
        window.location.href = result.url
      }
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/invoices/${id}`),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  })

  const invoices = data?.invoices ?? []
  const owed = invoices.reduce((sum, i) => sum + outstandingPence(i), 0)
  const overdue = invoices.filter((i) => invoiceState(i) === 'overdue')
  const overduePence = overdue.reduce((sum, i) => sum + outstandingPence(i), 0)

  return (
    <>
      <Card className='crate-card'>
        <CardHeader className='flex flex-row items-center justify-between'>
          <CardTitle className='flex items-center gap-2 display text-lg'>
            <span className='size-2.5 rounded-full border-[1.5px] border-bd-ink bg-bd-yellow' />
            Invoices
          </CardTitle>
          {canEdit && (
            <Button size='sm' onClick={() => setRaising(true)}>
              <Plus /> New invoice
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <div className='mb-3 crate-rule' />

          {/*
            The number first, then the detail. Whether anything is owed is the
            question this panel exists to answer, and on a client's own portal
            it is the only line most of them will read.
          */}
          {!isLoading && !isError && (
            <div
              className={cn(
                'mb-3 rounded-md border-2 px-3 py-2',
                overduePence > 0
                  ? 'border-pay-overdue bg-pay-overdue/10'
                  : owed > 0
                    ? 'border-pay-awaiting bg-pay-awaiting/10'
                    : 'border-bd-rule bg-bd-sand/40'
              )}
            >
              <p className='display text-2xl'>
                {owed > 0 ? formatPence(owed) : 'Nothing outstanding'}
              </p>
              <p
                className={cn(
                  'text-xs',
                  overduePence > 0
                    ? 'font-bold text-pay-overdue'
                    : 'text-muted-foreground'
                )}
              >
                {overduePence > 0
                  ? `${formatPence(overduePence)} overdue across ${overdue.length}`
                  : owed > 0
                    ? `${canEdit ? 'Owed by this client' : 'Outstanding on your account'}`
                    : 'Everything issued has been paid.'}
              </p>
            </div>
          )}

          {isLoading ? (
            <Skeleton className='h-24' />
          ) : isError ? (
            <QueryError
              title='Could not load invoices'
              error={error as Error}
              onRetry={() => refetch()}
            />
          ) : invoices.length === 0 ? (
            <p className='text-sm text-muted-foreground'>
              {canEdit
                ? 'No invoices yet. Raise one to start tracking what is owed.'
                : 'No invoices yet.'}
            </p>
          ) : (
            <ul className='divide-y divide-bd-rule-soft'>
              {invoices.map((invoice) => (
                <InvoiceRow
                  key={invoice.id}
                  invoice={invoice}
                  canEdit={canEdit}
                  onIssue={() =>
                    patch.mutate({ id: invoice.id, status: 'sent' })
                  }
                  onVoid={() =>
                    patch.mutate({ id: invoice.id, status: 'void' })
                  }
                  onDelete={() => remove.mutate(invoice.id)}
                  onAttach={(chosen) =>
                    attach.mutate({ invoiceId: invoice.id, file: chosen })
                  }
                  onPay={() => checkout.mutate(invoice.id)}
                  paying={
                    checkout.isPending && checkout.variables === invoice.id
                  }
                  attaching={
                    attach.isPending && attach.variables?.invoiceId === invoice.id
                  }
                  onRecordPayment={() => setPayingFor(invoice)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {canEdit && (
        <>
          <RaiseInvoiceDialog
            clientId={clientId}
            open={raising}
            onClose={() => setRaising(false)}
            onDone={invalidate}
          />
          <RecordPaymentDialog
            invoice={payingFor}
            onClose={() => setPayingFor(null)}
            onDone={invalidate}
          />
        </>
      )}
    </>
  )
}

function InvoiceRow({
  invoice,
  canEdit,
  onIssue,
  onVoid,
  onDelete,
  onAttach,
  attaching,
  onPay,
  paying,
  onRecordPayment,
}: {
  invoice: Invoice
  canEdit: boolean
  onIssue: () => void
  onVoid: () => void
  onDelete: () => void
  onAttach: (chosen: File) => void
  attaching: boolean
  onPay: () => void
  paying: boolean
  onRecordPayment: () => void
}) {
  const state = invoiceState(invoice)
  const settled = state === 'paid' || state === 'void'

  return (
    <li className='group flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5'>
      <span className='min-w-0 flex-1'>
        <span className='flex items-center gap-2'>
          <span className='truncate text-sm font-semibold'>
            {invoice.number}
          </span>
          <InvoiceStatePill invoice={invoice} />
        </span>
        <span className='block truncate text-xs text-muted-foreground'>
          {invoice.description ?? 'No description'}
          {invoice.dueOn && state !== 'overdue' && ` · due ${invoice.dueOn}`}
        </span>
        {/*
          The document itself, which the portal never held before — it tracked
          the amount and left the actual invoice in her email.

          The link is the same `files` row the File Folder lists, not a second
          copy, so there is one set of bytes and one thing to delete. On a
          DRAFT the client cannot see either the invoice or this: the row
          inherits the invoice's visibility.
        */}
        {invoice.attachmentId && (
          <a
            href={fileUrl(invoice.attachmentId)}
            className='mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:underline'
          >
            <Paperclip className='size-3 shrink-0' />
            <span className='truncate'>
              {invoice.attachmentName ?? 'Attached document'}
            </span>
          </a>
        )}
      </span>

      <span className='shrink-0 display text-base'>
        {formatPence(invoice.amountPence, invoice.currency)}
      </span>

      {/*
        The invoice as a document — her layout, printable, with the Pay button
        on it.

        Sofia sent a photo of a real Banana Digital invoice and asked whether
        "stripe could generate invoices like this". It could not, so this
        product does; see features/invoices/document.tsx. The link is offered
        to BOTH audiences and only once the invoice is issued, because a draft
        has no client-visible existence and rendering hers as a finished
        document invites her to send one she has not agreed to charge yet.
      */}
      {invoice.issuedOn && (
        <Button
          size='sm'
          variant='outline'
          className='h-7 shrink-0 px-2 text-xs'
          asChild
        >
          <Link
            to='/invoices/$invoiceId'
            params={{ invoiceId: invoice.id }}
            title={`Open ${invoice.number} as a document`}
          >
            <FileText className='size-3' />
            Invoice
          </Link>
        </Button>
      )}

      {/*
        The client's half. Everything above this is read-only for them; this is
        the one thing they can DO with an invoice, so it is a solid button
        rather than one of the hover-revealed staff actions.
      */}
      {!canEdit && state !== 'void' && state !== 'paid' && invoice.issuedOn && (
        <Button size='sm' onClick={onPay} disabled={paying} className='shrink-0'>
          {paying ? (
            <Loader2 className='size-3.5 animate-spin' />
          ) : (
            <CreditCard className='size-3.5' />
          )}
          Pay now
        </Button>
      )}

      {canEdit && (
        <span className='flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100'>
          {/*
            Hers: a payment link to send. The client sees the same control read
            "Pay now" and it takes them straight to Stripe — one endpoint, two
            audiences, because what differs is who is asking rather than what
            is being asked for.

            Only on an issued invoice with something still owed: a draft has no
            client-visible existence to pay against, a settled one has nothing
            to collect, and a voided one should not be collectable at all. The
            server refuses each of those independently — this just declines to
            offer a button that would be told no.
          */}
          {state !== 'void' && state !== 'paid' && invoice.issuedOn && (
            <Button
              size='sm'
              variant='ghost'
              className='h-7 px-2 text-xs'
              onClick={onPay}
              disabled={paying}
            >
              {paying ? (
                <Loader2 className='size-3 animate-spin' />
              ) : (
                <CreditCard className='size-3' />
              )}
              Send payment request
            </Button>
          )}
          <UploadButton
            size='sm'
            variant='ghost'
            className='h-7 px-2 text-xs'
            label={invoice.attachmentId ? 'Replace PDF' : 'Attach PDF'}
            icon={<Paperclip className='size-3' />}
            multiple={false}
            pending={attaching}
            onFiles={(list) => {
              const chosen = list[0]
              if (chosen) onAttach(chosen)
            }}
          />
          {state === 'draft' && (
            <Button
              size='sm'
              variant='ghost'
              className='h-7 px-2 text-xs'
              onClick={onIssue}
              title='Issue this invoice — the client can then see it'
            >
              <Send className='size-3.5' /> Issue
            </Button>
          )}
          {!settled && state !== 'draft' && (
            <Button
              size='sm'
              variant='ghost'
              className='h-7 px-2 text-xs'
              onClick={onRecordPayment}
            >
              <Receipt className='size-3.5' /> Record payment
            </Button>
          )}
          {/*
            A draft can be deleted; anything issued can only be voided. The
            client already has a copy of an issued invoice, and making it
            vanish leaves them holding a document this system denies exists.
          */}
          {state === 'draft' ? (
            <Button
              size='icon'
              variant='ghost'
              className='size-7'
              onClick={onDelete}
              aria-label={`Delete ${invoice.number}`}
            >
              <Trash2 className='size-3.5 text-destructive' />
            </Button>
          ) : (
            state !== 'void' && (
              <Button
                size='icon'
                variant='ghost'
                className='size-7'
                onClick={onVoid}
                aria-label={`Void ${invoice.number}`}
                title='Void this invoice'
              >
                <Ban className='size-3.5 text-destructive' />
              </Button>
            )
          )}
        </span>
      )}
    </li>
  )
}

/**
 * Amounts are typed in pounds and stored in pence.
 *
 * The conversion happens once, here, at the boundary — everything below this
 * point is integer pence, which is the only unit money arithmetic is safe in.
 * Returns null for anything that is not a positive amount, so the caller can
 * refuse rather than send NaN.
 */
function poundsToPence(input: string): number | null {
  const trimmed = input.trim().replace(/^£/, '')
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  const [whole, frac = ''] = trimmed.split('.')
  const pence = Number(`${frac}00`.slice(0, 2))
  const total = Number(whole) * 100 + pence
  return total > 0 ? total : null
}

function RaiseInvoiceDialog({
  clientId,
  open,
  onClose,
  onDone,
}: {
  clientId: string
  open: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [form, setForm] = useState({
    amount: '',
    description: '',
    dueOn: '',
  })

  const create = useMutation({
    mutationFn: (issue: boolean) => {
      const amountPence = poundsToPence(form.amount)
      if (amountPence === null) {
        return Promise.reject(new Error('Enter an amount like 2400 or 2400.50'))
      }
      return api.post('/invoices', {
        clientId,
        amountPence,
        description: form.description.trim() || null,
        dueOn: form.dueOn || null,
        issue,
      })
    },
    onSuccess: () => {
      onDone()
      setForm({ amount: '', description: '', dueOn: '' })
      onClose()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='crate-card sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='display text-xl'>New invoice</DialogTitle>
        </DialogHeader>
        <div className='grid gap-3'>
          <div className='grid gap-1.5'>
            <Label htmlFor='inv-amount'>Amount (GBP)</Label>
            <Input
              id='inv-amount'
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder='2400.00'
              inputMode='decimal'
              autoFocus
            />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='inv-desc'>What it is for</Label>
            <Input
              id='inv-desc'
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              placeholder='Social media retainer — September'
            />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='inv-due'>Due date</Label>
            <Input
              id='inv-due'
              type='date'
              value={form.dueOn}
              onChange={(e) => setForm({ ...form, dueOn: e.target.value })}
            />
          </div>
        </div>
        <DialogFooter className='gap-2'>
          {/*
            Two buttons rather than a checkbox: issuing is what makes the
            invoice visible to the client, and that is worth being an explicit
            act rather than a box someone leaves ticked from last time.
          */}
          <Button
            variant='outline'
            onClick={() => create.mutate(false)}
            disabled={create.isPending}
          >
            Save as draft
          </Button>
          <Button
            onClick={() => create.mutate(true)}
            disabled={create.isPending}
          >
            <Send /> Issue now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RecordPaymentDialog({
  invoice,
  onClose,
  onDone,
}: {
  invoice: Invoice | null
  onClose: () => void
  onDone: () => void
}) {
  const [form, setForm] = useState({
    amount: '',
    paidOn: '',
    method: '',
    reference: '',
  })

  const { data } = useQuery({
    queryKey: ['invoice', invoice?.id],
    queryFn: () =>
      api.get<{ invoice: Invoice; payments: InvoicePayment[] }>(
        `/invoices/${invoice!.id}`
      ),
    enabled: !!invoice,
  })

  const record = useMutation({
    mutationFn: () => {
      const amountPence = poundsToPence(form.amount)
      if (amountPence === null) {
        return Promise.reject(new Error('Enter an amount like 300 or 300.50'))
      }
      return api.post(`/invoices/${invoice!.id}/payments`, {
        amountPence,
        paidOn: form.paidOn || todayLocal(),
        method: form.method.trim() || null,
        reference: form.reference.trim() || null,
      })
    },
    onSuccess: () => {
      onDone()
      setForm({ amount: '', paidOn: '', method: '', reference: '' })
      onClose()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const outstanding = invoice ? outstandingPence(invoice) : 0

  return (
    <Dialog open={!!invoice} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='crate-card sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='display text-xl'>
            Record a payment
          </DialogTitle>
        </DialogHeader>

        {invoice && (
          <p className='text-sm text-muted-foreground'>
            {invoice.number} ·{' '}
            <strong>{formatPence(outstanding, invoice.currency)}</strong>{' '}
            outstanding of {formatPence(invoice.amountPence, invoice.currency)}
          </p>
        )}

        <div className='grid gap-3'>
          <div className='grid gap-1.5'>
            <Label htmlFor='pay-amount'>Amount received (GBP)</Label>
            <Input
              id='pay-amount'
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder={(outstanding / 100).toFixed(2)}
              inputMode='decimal'
              autoFocus
            />
            <p className='text-xs text-muted-foreground'>
              Part payments are fine — a deposit and a balance are two receipts
              against this invoice.
            </p>
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div className='grid gap-1.5'>
              <Label htmlFor='pay-date'>Received on</Label>
              <Input
                id='pay-date'
                type='date'
                value={form.paidOn || todayLocal()}
                onChange={(e) => setForm({ ...form, paidOn: e.target.value })}
              />
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='pay-method'>Method</Label>
              <Input
                id='pay-method'
                value={form.method}
                onChange={(e) => setForm({ ...form, method: e.target.value })}
                placeholder='Bank transfer'
              />
            </div>
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='pay-ref'>Their reference</Label>
            <Input
              id='pay-ref'
              value={form.reference}
              onChange={(e) => setForm({ ...form, reference: e.target.value })}
              placeholder='So a bank statement can be matched to this'
            />
          </div>
        </div>

        {/* Receipts already issued against this invoice. */}
        {!!data?.payments.length && (
          <div>
            <p className='mb-1.5 pb-1 display text-sm crate-rule'>Receipts</p>
            <ul className='space-y-1'>
              {data.payments.map((p) => (
                <li
                  key={p.id}
                  className='flex items-center justify-between text-xs'
                >
                  <span className='text-muted-foreground'>
                    {p.receiptNumber} · {p.paidOn}
                    {p.method ? ` · ${p.method}` : ''}
                  </span>
                  <span className='font-semibold'>
                    {formatPence(p.amountPence)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button onClick={() => record.mutate()} disabled={record.isPending}>
            <Receipt /> Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Today, from local parts. Never toISOString — that is a UTC day. */
function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
