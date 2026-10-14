import { Link, useNavigate, useParams } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronRight,
  History as HistoryIcon,
  Link2,
  Pencil,
} from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { ApiError, type PageRef } from '../lib/api'
import { usePage, usePageKeys, usePageTitles, useWiki } from '../lib/queries'
import {
  FOLDERS,
  folderOf,
  headings,
  splitFrontmatter,
  stripTitle,
} from '../lib/wiki'
import { FrontChips, TypeChip } from '../components/Chips'
import { Markdown } from '../components/Markdown'
import { Loading, NotFound, Problem } from '../components/States'

export function PageView() {
  const { _splat: key = '' } = useParams({ strict: false }) as {
    _splat?: string
  }
  const page = usePage(key)
  const keys = usePageKeys()
  const titles = usePageTitles()
  const wiki = useWiki()
  const navigate = useNavigate()
  const rawPaths = useMemo(
    () => new Set(wiki.data?.raw.map((file) => file.path) ?? []),
    [wiki.data],
  )
  const body = useMemo(
    () => (page.data ? stripTitle(splitFrontmatter(page.data.text).body) : ''),
    [page.data],
  )
  const toc = useMemo(() => headings(body), [body])

  useEffect(() => {
    if (page.data) document.title = `${page.data.title} · llm-wiki`
    return () => {
      document.title = 'llm-wiki'
    }
  }, [page.data])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (
        target.isContentEditable ||
        ['INPUT', 'TEXTAREA'].includes(target.tagName)
      )
        return
      if (
        event.key === 'e' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault()
        navigate({ to: '/edit/$', params: { _splat: key } })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [key, navigate])

  // Scroll to the anchor once the page has rendered.
  useEffect(() => {
    if (!page.data || !location.hash) return
    document
      .getElementById(decodeURIComponent(location.hash.slice(1)))
      ?.scrollIntoView()
  }, [page.data])

  if (page.isError)
    return page.error instanceof ApiError && page.error.status === 404 ? (
      <div className="px-5">
        <NotFound />
        <p className="text-center">
          <Link
            to="/new"
            search={{ name: key, folder: undefined, template: undefined }}
            className="btn"
          >
            Create {key}
          </Link>
        </p>
      </div>
    ) : (
      <Problem title="This page could not be loaded">
        {page.error.message}
      </Problem>
    )

  const folder = folderOf(key)
  return (
    <div className="mx-auto max-w-6xl px-5 pb-24 pt-6 sm:px-8 lg:pt-10">
      <div className="grid gap-x-12 xl:grid-cols-[minmax(0,1fr)_15rem]">
        <article className="mx-auto w-full min-w-0 max-w-[44rem]">
          {!page.data ? (
            <Loading />
          ) : (
            <>
              <nav
                className="mb-3 flex items-center gap-1 text-sm text-ink-3"
                aria-label="Breadcrumb"
              >
                <Link to="/" className="hover:text-ink">
                  Home
                </Link>
                {folder && (
                  <>
                    <ChevronRight size={13} />
                    <Link
                      to="/pages"
                      search={{ filter: folder }}
                      className="hover:text-ink"
                    >
                      {FOLDERS[folder] ?? folder}
                    </Link>
                  </>
                )}
              </nav>
              <header className="mb-8 border-b border-line pb-6">
                <h1 className="font-serif text-[1.9rem] font-semibold leading-[1.15] tracking-tight text-balance sm:text-[2.35rem]">
                  {page.data.title}
                </h1>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <FrontChips front={page.data.front} />
                  <div className="ml-auto flex gap-1.5">
                    <Link
                      to="/history/$"
                      params={{ _splat: key }}
                      search={{ rev: undefined }}
                      className="btn ghost"
                      title="History"
                    >
                      <HistoryIcon size={15} />
                      <span className="hidden sm:inline">History</span>
                    </Link>
                    <Link
                      to="/edit/$"
                      params={{ _splat: key }}
                      className="btn"
                      title="Edit (e)"
                    >
                      <Pencil size={15} /> Edit
                    </Link>
                  </div>
                </div>
              </header>

              {(page.data.brokenLinks.length > 0 ||
                page.data.missingRaw.length > 0) && (
                <div className="mb-6 flex gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm">
                  <AlertTriangle
                    size={17}
                    className="mt-0.5 shrink-0 text-danger"
                  />
                  <div>
                    <p className="font-medium text-danger">
                      This page has links that go nowhere
                    </p>
                    <p className="mt-0.5 text-ink-2">
                      {[...page.data.brokenLinks, ...page.data.missingRaw].map(
                        (target, i) => (
                          <code
                            key={target}
                            className="mr-1.5 font-mono text-xs"
                          >
                            {i ? ' ' : ''}
                            {target}
                          </code>
                        ),
                      )}
                    </p>
                  </div>
                </div>
              )}

              <Markdown
                text={body}
                keys={keys}
                titles={titles}
                rawPaths={rawPaths}
                currentKey={key}
              />

              <Backlinks
                backlinks={page.data.backlinks}
                className="mt-14 xl:hidden"
              />
              <footer className="mt-12 border-t border-line pt-4 font-mono text-xs text-ink-3">
                {page.data.path}
              </footer>
            </>
          )}
        </article>

        <aside className="hidden xl:block">
          <div className="scroll-thin sticky top-10 max-h-[calc(100dvh-5rem)] space-y-8 overflow-y-auto pb-6">
            {toc.length > 1 && (
              <nav>
                <h2 className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.1em] text-ink-3">
                  On this page
                </h2>
                <ul className="space-y-1 text-sm">
                  {toc.map((heading) => (
                    <li
                      key={heading.id}
                      style={{
                        paddingLeft: heading.depth === 3 ? '0.75rem' : 0,
                      }}
                    >
                      <a
                        href={`#${heading.id}`}
                        className="block truncate text-ink-2 hover:text-accent"
                      >
                        {heading.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
            {page.data && <Backlinks backlinks={page.data.backlinks} compact />}
          </div>
        </aside>
      </div>
    </div>
  )
}

function Backlinks({
  backlinks,
  className = '',
  compact = false,
}: {
  backlinks: PageRef[]
  className?: string
  compact?: boolean
}) {
  const list = backlinks.filter((ref) => ref.key !== 'index')
  return (
    <section className={className}>
      <h2 className="mb-2 flex items-center gap-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.1em] text-ink-3">
        <Link2 size={13} /> Linked from{' '}
        {list.length > 0 && (
          <span className="font-medium">· {list.length}</span>
        )}
      </h2>
      {list.length === 0 ? (
        <p className="text-sm text-ink-3">No other page links here yet.</p>
      ) : compact ? (
        <ul className="space-y-1 text-sm">
          {list.map((ref) => (
            <li key={ref.key}>
              <Link
                to="/page/$"
                params={{ _splat: ref.key }}
                className="block truncate text-ink-2 hover:text-accent"
              >
                {ref.title}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {list.map((ref) => (
            <Link
              key={ref.key}
              to="/page/$"
              params={{ _splat: ref.key }}
              className="group flex items-center gap-2 rounded-xl border border-line bg-elev px-3.5 py-2.5 transition hover:border-line-strong"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{ref.title}</span>
                <span className="block truncate font-mono text-[0.7rem] text-ink-3">
                  {ref.key}
                </span>
              </span>
              <TypeChip type={ref.front?.type} />
              <ArrowUpRight
                size={15}
                className="shrink-0 text-ink-3 group-hover:text-accent"
              />
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}
