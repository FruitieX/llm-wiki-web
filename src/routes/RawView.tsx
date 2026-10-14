import { Link, useParams } from '@tanstack/react-router'
import { ChevronRight, Lock } from 'lucide-react'
import { useMemo } from 'react'
import { ApiError } from '../lib/api'
import { usePageKeys, useRaw } from '../lib/queries'
import { Markdown } from '../components/Markdown'
import { Loading, NotFound, Problem } from '../components/States'

function size(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`
}

/** Raw evidence is immutable: shown, never edited. */
export function RawView() {
  const { _splat: path = '' } = useParams({ strict: false }) as {
    _splat?: string
  }
  const raw = useRaw(path)
  const keys = usePageKeys()
  const markdown = path.endsWith('.md')
  const text = useMemo(
    () => raw.data?.text?.replace(/^---\n[\s\S]*?\n---\n/, '') ?? '',
    [raw.data],
  )

  if (raw.isError)
    return raw.error instanceof ApiError && raw.error.status === 404 ? (
      <NotFound what="raw file" />
    ) : (
      <Problem title="This file could not be loaded">
        {raw.error.message}
      </Problem>
    )

  return (
    <div className="mx-auto max-w-4xl px-5 pb-24 pt-6 sm:px-8 lg:pt-10">
      <nav className="mb-3 flex items-center gap-1 text-sm text-ink-3">
        <Link to="/" className="hover:text-ink">
          Home
        </Link>
        <ChevronRight size={13} />
        <span>Raw evidence</span>
      </nav>
      <header className="mb-6 border-b border-line pb-5">
        <h1 className="break-all font-mono text-lg font-semibold sm:text-xl">
          {path.replace(/^raw\//, '')}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-3">
          <span className="chip">
            <Lock size={12} /> read-only evidence
          </span>
          {raw.data && <span>{size(raw.data.size)}</span>}
        </div>
      </header>
      {!raw.data ? (
        <Loading />
      ) : raw.data.text === null ? (
        <p className="text-ink-2">
          This file is binary or too large to show here.
        </p>
      ) : markdown ? (
        <div className="rounded-2xl border border-line bg-elev px-5 py-6 sm:px-8">
          <Markdown text={text} keys={keys} />
        </div>
      ) : (
        <pre className="scroll-thin overflow-x-auto rounded-2xl border border-line bg-sunk p-4 font-mono text-[0.8rem] leading-relaxed">
          {raw.data.text}
        </pre>
      )}
      {raw.data && (
        <section className="mt-10">
          <h2 className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.1em] text-ink-3">
            Cited by
          </h2>
          {raw.data.citedBy.length === 0 ? (
            <p className="text-sm text-ink-3">No page cites this file.</p>
          ) : (
            <ul className="space-y-1">
              {raw.data.citedBy.map((ref) => (
                <li key={ref.key}>
                  <Link
                    to="/page/$"
                    params={{ _splat: ref.key }}
                    className="text-accent hover:underline"
                  >
                    {ref.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
