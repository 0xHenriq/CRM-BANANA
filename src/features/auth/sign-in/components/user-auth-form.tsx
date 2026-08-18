import { useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, LogIn } from 'lucide-react'
import { toast } from 'sonner'
import { signIn } from '@/lib/auth-client'
import { cn } from '@/lib/utils'
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

const formSchema = z.object({
  email: z.email({
    error: (iss) => (iss.input === '' ? 'Please enter your email.' : undefined),
  }),
  // No client-side length rule: the server owns password policy, and a
  // front-end minimum that disagrees with it just produces a confusing error.
  password: z.string().min(1, 'Please enter your password.'),
})

interface UserAuthFormProps extends React.HTMLAttributes<HTMLFormElement> {
  redirectTo?: string
}

export function UserAuthForm({
  className,
  redirectTo,
  ...props
}: UserAuthFormProps) {
  const [isLoading, setIsLoading] = useState(false)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: '', password: '' },
  })

  async function onSubmit(data: z.infer<typeof formSchema>) {
    setIsLoading(true)
    const { error } = await signIn.email({
      email: data.email,
      password: data.password,
    })
    setIsLoading(false)

    if (error) {
      // Being rate limited is a different problem from a wrong password, and
      // saying "that did not match" sends the user to retype it — which is
      // exactly what deepens the lockout. Distinguishing 429 leaks nothing:
      // it is about the request, not about whether the account exists.
      if (error.status === 429) {
        toast.error(
          'Too many sign-in attempts from this network. Please wait a few minutes and try again.'
        )
        return
      }

      // Otherwise never distinguish "no such account" from "wrong password":
      // that turns the form into an account-enumeration oracle.
      toast.error('That email and password did not match.')
      form.setValue('password', '')
      return
    }

    await queryClient.invalidateQueries({ queryKey: ['me'] })
    navigate({ to: redirectTo || '/', replace: true })
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className={cn('grid gap-3', className)}
        {...props}
      >
        <FormField
          control={form.control}
          name='email'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input
                  placeholder='name@example.com'
                  autoComplete='email'
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
              <FormLabel>Password</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder='••••••••'
                  autoComplete='current-password'
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button className='mt-2' disabled={isLoading}>
          {isLoading ? <Loader2 className='animate-spin' /> : <LogIn />}
          Sign in
        </Button>
      </form>
    </Form>
  )
}
