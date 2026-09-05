import type { ReactNode } from 'react'
import './globals.css'

export const metadata = {
  title: 'Chorus',
  description: 'Where a team agrees on what to build.',
}

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
