import { Link } from '@tanstack/react-router'
import { AlertTriangle, FileQuestion } from 'lucide-react'
import type { ReactNode } from 'react'

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div
      className="animate-pulse space-y-4 py-2"
      aria-label={label}
      role="status"
    >
      <div className="h-8 w-2/3 rounded-lg bg-sunk" />
      <div className="h-4 w-1/3 rounded bg-sunk" />
      <div className="space-y-2 pt-4">
        <div className="h-4 rounded bg-sunk" />
        <div className="h-4 rounded bg-sunk" />
        <div className="h-4 w-5/6 rounded bg-sunk" />
      </div>
    </div>
  )
}

export function Problem({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <AlertTriangle className="mx-auto mb-3 text-warn" size={28} />
      <h1 className="font-serif text-xl font-semibold">{title}</h1>
      <div className="mt-2 text-ink-2">{children}</div>
    </div>
  )
}

export function NotFound({ what = 'page' }: { what?: string }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <FileQuestion className="mx-auto mb-3 text-ink-3" size={28} />
      <h1 className="font-serif text-xl font-semibold">No such {what}</h1>
      <p className="mt-2 text-ink-2">
        It may have been moved or removed.{' '}
        <Link to="/" className="text-accent underline">
          Back to the start
        </Link>
      </p>
    </div>
  )
}
