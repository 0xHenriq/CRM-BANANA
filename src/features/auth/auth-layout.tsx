import { PeelMark } from '@/components/layout/app-title'

type AuthLayoutProps = {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className='container grid h-svh max-w-none items-center justify-center'>
      <div className='mx-auto flex w-full flex-col justify-center space-y-2 py-8 sm:p-8'>
        <div className='mb-5 flex flex-col items-center'>
          <div className='flex items-center gap-2.5'>
            <PeelMark outline='ink' />
            <span className='display text-2xl'>Banana Digital</span>
          </div>
          <span className='mt-1.5 text-[0.625rem] tracking-[0.16em] text-muted-foreground uppercase'>
            Client Portal
          </span>
        </div>
        {children}
      </div>
    </div>
  )
}
