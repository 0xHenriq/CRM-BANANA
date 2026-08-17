import { useSearch } from '@tanstack/react-router'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { AuthLayout } from '../auth-layout'
import { UserAuthForm } from './components/user-auth-form'

export function SignIn() {
  const { redirect } = useSearch({ from: '/(auth)/sign-in' })

  return (
    <AuthLayout>
      <Card className='crate-card max-w-sm gap-4'>
        <CardHeader>
          <CardTitle className='display text-2xl'>Sign in</CardTitle>
          <CardDescription>
            {/* No public sign-up: seats are invite-only and capped at 10.
                Access is granted by the agency, never self-served. */}
            Enter the email and password from your invitation. Need access? Ask
            your Banana Digital contact.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UserAuthForm redirectTo={redirect} />
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
