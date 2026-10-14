import { Link } from '@tanstack/react-router'
import { GitCommitHorizontal, Pencil } from 'lucide-react'
import { useMemo } from 'react'
import type { Commit, PageSummary } from '../lib/api'
import { usePage, usePageKeys, useRecent, useWiki } from '../lib/queries'
import { normalizeKey, relativeTime, splitFrontmatter } from '../lib/wiki'
import { FrontChips } from '../components/Chips'
import { Markdown } from '../components/Markdown'
import { Loading, Problem } from '../components/States'

type Entry = { key: string; label?: string; description: string }
type Section = { title: string; entries: Entry[]; other: string }

function parseIndex(text: string): { intro: string; sections: Section[] } {
  const { body } = splitFrontmatter(text)
  const lines = body.replace(/^\s*# .*\n?/, '').split('\n')
  const intro: string[] = []
  const sections: Section[] = []
  for (const line of lines) {
    const heading = line.match(/^##\s+(.*)$/)
    if (heading) {
      sections.push({ title: heading[1].trim(), entries: [], other: '' })
      continue
    }
    const section = sections[sections.length - 1]
    if (!section) {
      intro.push(line)
      continue
    }
    const entry = line.match(
      /^[-*]\s+\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]\s*(?:[—–:-]\s*)?(.*)$/,
    )
    if (entry)
      section.entries.push({
        key: normalizeKey(entry[1]),
        label: entry[2],
        description: entry[3],
      })
    else section.other += line + '\n'
  }
  return { intro: intro.join('\n').trim(), sections }
}

export function Home() {
  const wiki = useWiki()
  const index = usePage('index')
  const recent = useRecent(25)
  const keys = usePageKeys()
  const pages = useMemo(
    () => new Map(wiki.data?.pages.map((p) => [p.key, p]) ?? []),
    [wiki.data],
  )
  const parsed = useMemo(
    () => (index.data ? parseIndex(index.data.text) : null),
    [index.data],
  )

  if (index.isError)
    return (
      <Problem title="The index could not be loaded">
        {index.error.message}
      </Problem>
    )

  return (
    <div className="mx-auto max-w-6xl px-5 pb-24 pt-8 sm:px-8 lg:pt-14">
      <div className="grid gap-x-12 gap-y-10 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <header className="mb-8">
            <p className="text-sm font-medium text-ink-3">
              {wiki.data
                ? `${wiki.data.pages.length} pages · ${wiki.data.raw.length} raw captures`
                : ' '}
            </p>
            <h1 className="mt-1 font-serif text-[2rem] font-semibold leading-tight tracking-tight sm:text-[2.4rem]">
              Operational memory
            </h1>
            {parsed?.intro && (
              <div className="mt-3 max-w-2xl text-ink-2 [&_.prose-wiki]:text-[1rem] [&_.prose-wiki]:text-ink-2">
                <Markdown text={parsed.intro} keys={keys} compact />
              </div>
            )}
            <div className="mt-4 flex gap-2">
              <Link
                to="/page/$"
                params={{ _splat: 'agent-start' }}
                className="btn"
              >
                Agent start
              </Link>
              <Link
                to="/edit/$"
                params={{ _splat: 'index' }}
                className="btn ghost"
              >
                <Pencil size={15} /> Edit index
              </Link>
            </div>
          </header>

          <div className="xl:hidden">
            <RecentChanges
              commits={recent.data?.commits}
              pages={pages}
              limit={4}
            />
          </div>

          {!parsed ? (
            <Loading />
          ) : (
            <div className="space-y-10">
              {parsed.sections.map((section) => (
                <section key={section.title}>
                  <h2 className="mb-3 text-[0.75rem] font-semibold uppercase tracking-[0.1em] text-ink-3">
                    {section.title}
                  </h2>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {section.entries.map((entry) => (
                      <IndexCard
                        key={entry.key}
                        entry={entry}
                        page={pages.get(entry.key)}
                      />
                    ))}
                  </div>
                  {section.other.trim() && (
                    <div className="mt-3">
                      <Markdown text={section.other} keys={keys} compact />
                    </div>
                  )}
                </section>
              ))}
            </div>
          )}
        </div>

        <aside className="hidden xl:block">
          <div className="sticky top-8">
            <RecentChanges
              commits={recent.data?.commits}
              pages={pages}
              limit={14}
            />
          </div>
        </aside>
      </div>
    </div>
  )
}

function IndexCard({ entry, page }: { entry: Entry; page?: PageSummary }) {
  const broken = !page
  return (
    <Link
      to="/page/$"
      params={{ _splat: entry.key }}
      className={`group block rounded-xl border bg-elev px-4 py-3 transition hover:border-line-strong hover:shadow-soft ${
        broken ? 'border-danger/40' : 'border-line'
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          className={`font-serif text-[1.02rem] font-semibold leading-snug ${broken ? 'text-danger' : ''}`}
        >
          {entry.label ?? page?.title ?? entry.key}
        </span>
        <span className="ml-auto mt-0.5 shrink-0">
          {page && <FrontChips front={page.front} compact />}
        </span>
      </div>
      <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-ink-2">
        {broken
          ? `Missing page: ${entry.key}`
          : entry.description || page.summary}
      </p>
    </Link>
  )
}

function RecentChanges({
  commits,
  pages,
  limit,
}: {
  commits?: Commit[]
  pages: Map<string, PageSummary>
  limit: number
}) {
  return (
    <section className="mb-10 xl:mb-0">
      <h2 className="mb-3 text-[0.75rem] font-semibold uppercase tracking-[0.1em] text-ink-3">
        Recently changed
      </h2>
      {!commits ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-sunk" />
          ))}
        </div>
      ) : (
        <ol className="relative space-y-4 border-l border-line pl-4">
          {commits.slice(0, limit).map((commit) => {
            const touched = commit.files
              .map((file) => file.path.match(/^wiki\/(.*)\.md$/)?.[1])
              .filter((key): key is string => !!key && pages.has(key))
            return (
              <li key={commit.hash} className="relative">
                <GitCommitHorizontal
                  size={14}
                  className="absolute -left-[1.4rem] top-0.5 bg-bg text-ink-3"
                />
                <p className="text-sm leading-snug text-ink">
                  {commit.subject}
                </p>
                <p className="mt-0.5 text-xs text-ink-3">
                  {commit.author} · {relativeTime(commit.date)}
                </p>
                {touched.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs">
                    {touched.slice(0, 4).map((key) => (
                      <Link
                        key={key}
                        to="/page/$"
                        params={{ _splat: key }}
                        className="text-accent hover:underline"
                      >
                        {pages.get(key)!.title}
                      </Link>
                    ))}
                    {touched.length > 4 && (
                      <span className="text-ink-3">
                        +{touched.length - 4} more
                      </span>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
