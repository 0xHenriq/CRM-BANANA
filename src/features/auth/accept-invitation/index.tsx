import { useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { signIn } from '@/lib/auth-client'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/password-input'
import { AuthLayout } from '../auth-layout'

const schema = z.object({
  name: z.string().min(1, 'Please enter your name.'),
  password: z.string().min(10, 'Use at least 10 characters.'),
})

type Invitation = { email: string; role: string }

export function AcceptInvitation() {
  const { invitationId } = useParams({ from: '/(auth)/accept-invitation/$invitationId' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const { data, isLoading, isError } = useQuery<Invitation>({
    queryKey: ['invitation', invitationId],
    queryFn: async () => {
      const res = await fetch(`/api/invitations/${invitationId}`)
      if (!res.ok) throw new Error('invalid')
      return res.json()
    },
    retry: false,
  })

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', password: '' },
  })

  async function onSubmit(values: z.infer<typeof schema>) {
    setIsSubmitting(true)
    const res = await fetch(`/api/invitations/${invitationId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    })

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      toast.error(body.error ?? 'Could not accept this invitation.')
      setIsSubmitting(false)
      return
    }

    const { email } = (await res.json()) as { email: string }
    // Sign in through the same path everyone else uses, rather than having
    // the accept endpoint mint a session of its own.
    const { error } = await signIn.email({ email, password: values.password })
    setIsSubmitting(false)

    if (error) {
      toast.success('Account created — please sign in.')
      navigate({ to: '/sign-in', replace: true })
      return
    }

    await queryClient.invalidateQueries({ queryKey: ['me'] })
    navigate({ to: '/', replace: true })
  }

  if (isLoading) {
    return (
      <AuthLayout>
        <Card className='crate-card max-w-sm'>
          <CardContent className='flex items-center gap-2 py-8 text-sm text-muted-foreground'>
            <Loader2 className='size-4 animate-spin' />
            Checking your invitation…
          </CardContent>
        </Card>
      </AuthLayout>
    )
  }

  if (isError || !data) {
    return (
      <AuthLayout>
        <Card className='crate-card max-w-sm'>
          <CardHeader>
            <CardTitle className='display text-2xl'>
              Invitation not valid
            </CardTitle>
            <CardDescription>
              This link has expired or has already been used. Ask your Banana
              Digital contact for a fresh one.
            </CardDescription>
          </CardHeader>
        </Card>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <Card className='crate-card max-w-sm gap-4'>
        <CardHeader>
          <CardTitle className='display text-2xl'>Set up your account</CardTitle>
          <CardDescription>
            Invited as <span className='font-semibold'>{data.email}</span>
            {data.role === 'client'
              ? ' — you will see your own workspace.'
              : ' — you will have agency access.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className='grid gap-3'
            >
              <FormField
                control={form.control}
                name='name'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Your name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder='Jane Smith'
                        autoComplete='name'
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='password'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Choose a password</FormLabel>
                    <FormControl>
                      <PasswordInput
                        placeholder='At least 10 characters'
                        autoComplete='new-password'
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button className='mt-2' disabled={isSubmitting}>
                {isSubmitting && <Loader2 className='animate-spin' />}
                Create account
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
